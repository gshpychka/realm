package incus

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"

	incus "github.com/lxc/incus/v7/client"
	"github.com/lxc/incus/v7/shared/api"

	"github.com/gshpychka/realm/packages/bay/internal/guest"
)

// imageKey holds the fingerprint of the image the warm base was booted from.
const imageKey = "user.bay.image"

// Reserved are the instance names the driver keeps for itself.
func (d *Driver) Reserved() []string {
	return []string{d.base, d.staging()}
}

func (d *Driver) staging() string {
	return d.base + "-next"
}

// UpdateBase makes the warm base the VM image made of the metadata and disk files, booted once, and deletes the
// project's other images; a base already booted from that image stays. ready returns when a booted guest has done its
// first-boot work. Create fails while a rebuilt base takes the old one's place.
func (d *Driver) UpdateBase(ctx context.Context, metadata, disk string, ready func(context.Context, guest.Exec) error) error {
	image, err := d.importImage(ctx, metadata, disk)
	if err != nil {
		return err
	}
	current, err := d.baseImage()
	if err != nil {
		return err
	}
	if current != image {
		slog.Info("building warm base", "image", image)
		if err := d.buildBase(ctx, image, ready); err != nil {
			return err
		}
	}
	return d.pruneImages(ctx, image)
}

// importImage returns the fingerprint of the VM image made of the metadata and disk files, importing it when the
// project lacks it.
func (d *Driver) importImage(ctx context.Context, metadata, disk string) (string, error) {
	fingerprint, err := fingerprintFiles(metadata, disk)
	if err != nil {
		return "", err
	}
	if _, _, err := d.server.GetImage(fingerprint); err == nil {
		return fingerprint, nil
	} else if !isNotFound(err) {
		return "", fmt.Errorf("image %s: %w", fingerprint, err)
	}
	meta, err := os.Open(metadata)
	if err != nil {
		return "", err
	}
	defer meta.Close()
	rootfs, err := os.Open(disk)
	if err != nil {
		return "", err
	}
	defer rootfs.Close()
	op, err := d.server.CreateImage(api.ImagesPost{}, &incus.ImageCreateArgs{
		MetaFile:   meta,
		MetaName:   filepath.Base(metadata),
		RootfsFile: rootfs,
		RootfsName: filepath.Base(disk),
		Type:       string(api.InstanceTypeVM),
	})
	if err != nil {
		return "", fmt.Errorf("import image: %w", err)
	}
	if err := wait(ctx, op, "import image"); err != nil {
		return "", err
	}
	return fingerprint, nil
}

// fingerprintFiles computes the fingerprint Incus gives a split image: the SHA-256 of its metadata then its disk.
func fingerprintFiles(paths ...string) (string, error) {
	hash := sha256.New()
	for _, path := range paths {
		f, err := os.Open(path)
		if err != nil {
			return "", err
		}
		_, err = io.Copy(hash, f)
		f.Close()
		if err != nil {
			return "", err
		}
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

// baseImage returns the fingerprint of the image the warm base was booted from, or "" when there is no base.
func (d *Driver) baseImage() (string, error) {
	inst, _, err := d.server.GetInstance(d.base)
	if isNotFound(err) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("instance %s: %w", d.base, err)
	}
	return inst.Config[imageKey], nil
}

// buildBase replaces the warm base with image booted once.
func (d *Driver) buildBase(ctx context.Context, image string, ready func(context.Context, guest.Exec) error) error {
	staging := d.staging()
	if err := d.Delete(ctx, staging); err != nil {
		return err
	}
	op, err := d.server.CreateInstance(api.InstancesPost{
		Name:        staging,
		Type:        api.InstanceTypeVM,
		Source:      api.InstanceSource{Type: "image", Fingerprint: image},
		InstancePut: api.InstancePut{Config: map[string]string{imageKey: image}},
	})
	if err != nil {
		return fmt.Errorf("create instance %s: %w", staging, err)
	}
	if err := wait(ctx, op, "create instance "+staging); err != nil {
		return err
	}
	if _, err := d.Start(ctx, staging); err != nil {
		return err
	}
	exec := func(ctx context.Context, argv []string, stdin io.Reader, stdout io.Writer) error {
		return d.Exec(ctx, staging, argv, stdin, stdout)
	}
	if err := ready(ctx, exec); err != nil {
		return err
	}
	op, err = d.server.UpdateInstanceState(staging, api.InstanceStatePut{Action: "stop", Timeout: 300}, "")
	if err != nil {
		return fmt.Errorf("stop instance %s: %w", staging, err)
	}
	if err := wait(ctx, op, "stop instance "+staging); err != nil {
		return err
	}
	// Incus renames only onto a free name
	if err := d.Delete(ctx, d.base); err != nil {
		return err
	}
	op, err = d.server.RenameInstance(staging, api.InstancePost{Name: d.base})
	if err != nil {
		return fmt.Errorf("rename instance %s: %w", staging, err)
	}
	return wait(ctx, op, "rename instance "+staging)
}

// pruneImages deletes every image in the project other than keep.
func (d *Driver) pruneImages(ctx context.Context, keep string) error {
	fingerprints, err := d.server.GetImageFingerprints()
	if err != nil {
		return fmt.Errorf("list images: %w", err)
	}
	for _, fingerprint := range fingerprints {
		if fingerprint == keep {
			continue
		}
		op, err := d.server.DeleteImage(fingerprint)
		if err != nil {
			return fmt.Errorf("delete image %s: %w", fingerprint, err)
		}
		if err := wait(ctx, op, "delete image "+fingerprint); err != nil {
			return err
		}
	}
	return nil
}
