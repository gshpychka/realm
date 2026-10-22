package repos

import (
	"archive/tar"
	"context"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
)

// writeTar writes the directories, regular files and symlinks under dir to w as a tar archive named relative to dir,
// keeping their permission bits, with every entry owned by root.
func writeTar(ctx context.Context, w io.Writer, dir string) error {
	tw := tar.NewWriter(w)
	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		rel, err := filepath.Rel(dir, path)
		if err != nil {
			return err
		}
		if rel == "." {
			return nil
		}
		return addEntry(tw, path, filepath.ToSlash(rel), d)
	})
	if err != nil {
		return err
	}
	return tw.Close()
}

func addEntry(tw *tar.Writer, path, name string, d fs.DirEntry) error {
	info, err := d.Info()
	if err != nil {
		return err
	}
	mode := info.Mode()
	hdr := &tar.Header{Name: name, Mode: int64(mode.Perm()), ModTime: info.ModTime()}
	switch {
	case mode.IsDir():
		hdr.Typeflag = tar.TypeDir
		hdr.Name += "/"
	case mode.IsRegular():
		hdr.Typeflag = tar.TypeReg
		hdr.Size = info.Size()
	case mode.Type() == fs.ModeSymlink:
		hdr.Typeflag = tar.TypeSymlink
		if hdr.Linkname, err = os.Readlink(path); err != nil {
			return err
		}
	default:
		return fmt.Errorf("%s is not a regular file, directory or symlink", name)
	}
	if err := tw.WriteHeader(hdr); err != nil {
		return err
	}
	if hdr.Typeflag != tar.TypeReg {
		return nil
	}
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = io.Copy(tw, f)
	return err
}
