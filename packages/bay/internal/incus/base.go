package incus

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"log/slog"
	"maps"
	"os"
	"path/filepath"
	"strconv"

	incus "github.com/lxc/incus/v7/client"
	"github.com/lxc/incus/v7/shared/api"

	"github.com/gshpychka/realm/packages/bay/internal/guest"
	"github.com/gshpychka/realm/packages/bay/internal/machines"
)

// imageKey holds the fingerprint of the image the warm base was booted from.
const imageKey = "user.bay.image"

const baseReadyKey = "user.bay.prepared"
const machineKey = "user.bay.machine"

// EnsureBase prepares exactly the declared immutable image/resource revision.
// Old bases and images stay available to pinned records; this operation never
// prunes another machine or replaces a prepared base during a new launch.
func (d *Driver) EnsureBase(ctx context.Context, machine machines.Definition, metadata, disk string, ready func(context.Context, guest.Exec) error) error {
	image, err := d.importImage(ctx, metadata, disk)
	if err != nil {
		return err
	}
	return d.ensureBase(ctx, machine, image, ready)
}

// PruneBases reclaims revisions not referenced by the catalog or a session record.
func (d *Driver) PruneBases(ctx context.Context, retained map[string]bool) error {
	instances, err := d.server.GetInstances(api.InstanceTypeVM)
	if err != nil {
		return fmt.Errorf("list machine bases: %w", err)
	}
	images, obsolete := map[string]bool{}, map[string]bool{}
	for _, instance := range instances {
		image := instance.Config[imageKey]
		if image == "" || instance.Config[machineKey] == "" || instance.Config[sessionKey] != "" {
			continue
		}
		if retained[instance.Name] {
			images[image] = true
			continue
		}
		if err := d.Delete(ctx, instance.Name); err != nil {
			return err
		}
		obsolete[image] = true
		slog.Info("obsolete machine base removed", "base", instance.Name)
	}
	for image := range obsolete {
		if images[image] {
			continue
		}
		op, err := d.server.DeleteImage(image)
		if err != nil {
			return fmt.Errorf("delete obsolete machine image: %w", err)
		}
		if err := wait(ctx, op, "delete obsolete machine image"); err != nil {
			return err
		}
	}
	return nil
}

func (d *Driver) ensureBase(ctx context.Context, machine machines.Definition, image string, ready func(context.Context, guest.Exec) error) error {
	current, _, err := d.server.GetInstance(machine.Base)
	if err == nil {
		if current.Config[sessionKey] != "" || current.Config[imageKey] != image || current.Config[machineKey] != machine.Revision {
			return fmt.Errorf("immutable base %s belongs to another image or machine revision", machine.Base)
		}
		if current.Config[baseReadyKey] == "true" {
			return nil
		}
		// A failed preparation cannot have admitted any session. Only this
		// matching, unfinished revision is safe to rebuild in place.
		if err := d.Delete(ctx, machine.Base); err != nil {
			return err
		}
	} else if !isNotFound(err) {
		return err
	}
	slog.Info("preparing machine", "base", machine.Base, "revision", machine.Revision, "image", image)
	put, err := d.instanceResources(machine.Resources)
	if err != nil {
		return err
	}
	// A base keeps only its disk.
	delete(put.Devices["root"], "size.state")
	put.Config[imageKey] = image
	put.Config[machineKey] = machine.Revision
	op, err := d.server.CreateInstance(api.InstancesPost{Name: machine.Base, Type: api.InstanceTypeVM, Source: api.InstanceSource{Type: "image", Fingerprint: image}, InstancePut: put})
	if err != nil {
		return fmt.Errorf("create base %s: %w", machine.Base, err)
	}
	if err := wait(ctx, op, "create base "+machine.Base); err != nil {
		return err
	}
	if _, err := d.Start(ctx, machine.Base); err != nil {
		return err
	}
	exec := func(ctx context.Context, argv []string, stdin io.Reader, stdout io.Writer) error {
		return d.Exec(ctx, machine.Base, argv, stdin, stdout)
	}
	if err := ready(ctx, exec); err != nil {
		return err
	}
	op, err = d.server.UpdateInstanceState(machine.Base, api.InstanceStatePut{Action: "stop", Timeout: 300}, "")
	if err != nil {
		return fmt.Errorf("stop base %s: %w", machine.Base, err)
	}
	if err := wait(ctx, op, "stop base "+machine.Base); err != nil {
		return err
	}
	current, etag, err := d.server.GetInstance(machine.Base)
	if err != nil {
		return err
	}
	prepared := current.Writable()
	prepared.Config[baseReadyKey] = "true"
	op, err = d.server.UpdateInstance(machine.Base, prepared, etag)
	if err != nil {
		return err
	}
	return wait(ctx, op, "publish base "+machine.Base)
}

// The local root device must carry the full profile device: Incus overrides a
// device by name, rather than merging individual keys from the profile.
func (d *Driver) instanceResources(resources machines.Resources) (api.InstancePut, error) {
	put := api.InstancePut{Config: map[string]string{}}
	profile, _, err := d.server.GetProfile("default")
	if err != nil {
		return put, fmt.Errorf("read machine resource profile: %w", err)
	}
	root := maps.Clone(profile.Devices["root"])
	if root["type"] != "disk" || root["path"] != "/" || root["pool"] == "" {
		return put, fmt.Errorf("Bay's default profile needs a managed root disk")
	}
	root["size"] = strconv.Itoa(resources.Disk) + "GiB"
	root["size.state"] = strconv.Itoa(resources.Memory+1) + "GiB"
	put.Devices = api.DevicesMap{"root": root}
	put.Config["limits.cpu"] = strconv.Itoa(resources.CPUs)
	put.Config["limits.memory"] = strconv.Itoa(resources.Memory) + "GiB"
	return put, nil
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
