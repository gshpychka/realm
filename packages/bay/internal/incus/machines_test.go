package incus

import (
	"context"
	"maps"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	incus "github.com/lxc/incus/v7/client"
	"github.com/lxc/incus/v7/shared/api"

	"github.com/gshpychka/realm/packages/bay/internal/guest"
	"github.com/gshpychka/realm/packages/bay/internal/machines"
)

type completedOperation struct{ incus.Operation }

func (completedOperation) WaitContext(context.Context) error { return nil }
func (completedOperation) Get() api.Operation {
	return api.Operation{Metadata: map[string]any{"return": float64(0)}}
}

// Any accidental image pruning or replacement of an existing prepared base
// calls an unimplemented method and fails, rather than quietly passing a mock.
type machineServer struct {
	incus.InstanceServer
	instances  map[string]*api.Instance
	deleted    []string
	clonedFrom string
}

func (f *machineServer) GetImage(string) (*api.Image, string, error) { return &api.Image{}, "", nil }
func (f *machineServer) GetInstance(name string) (*api.Instance, string, error) {
	inst, ok := f.instances[name]
	if !ok {
		return nil, "", api.StatusErrorf(http.StatusNotFound, "missing %s", name)
	}
	return inst, "", nil
}
func (f *machineServer) GetProfile(string) (*api.Profile, string, error) {
	return &api.Profile{ProfilePut: api.ProfilePut{Devices: api.DevicesMap{"root": {"type": "disk", "path": "/", "pool": "bay", "size": "50GiB"}}}}, "", nil
}
func (f *machineServer) CreateInstance(post api.InstancesPost) (incus.Operation, error) {
	f.clonedFrom = post.Source.Source
	f.instances[post.Name] = &api.Instance{Name: post.Name, InstancePut: post.InstancePut, StatusCode: api.Stopped}
	return completedOperation{}, nil
}
func (f *machineServer) UpdateInstanceState(name string, state api.InstanceStatePut, _ string) (incus.Operation, error) {
	if state.Action == "start" {
		f.instances[name].StatusCode = api.Running
	} else {
		f.instances[name].StatusCode = api.Stopped
	}
	return completedOperation{}, nil
}
func (f *machineServer) ExecInstance(_ string, _ api.InstanceExecPost, args *incus.InstanceExecArgs) (incus.Operation, error) {
	close(args.DataDone)
	return completedOperation{}, nil
}
func (f *machineServer) UpdateInstance(name string, put api.InstancePut, _ string) (incus.Operation, error) {
	f.instances[name].InstancePut = put
	return completedOperation{}, nil
}
func (f *machineServer) DeleteInstance(name string) (incus.Operation, error) {
	f.deleted = append(f.deleted, name)
	delete(f.instances, name)
	return completedOperation{}, nil
}

func TestPreparedMachinesCoexistAndCloneTheirPinnedResources(t *testing.T) {
	ctx := context.Background()
	server := &machineServer{instances: map[string]*api.Instance{}}
	driver := &Driver{server: server, base: "base"}
	dir := t.TempDir()
	metadata, disk := filepath.Join(dir, "metadata"), filepath.Join(dir, "disk")
	if err := os.WriteFile(metadata, []byte("metadata"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(disk, []byte("first image"), 0o600); err != nil {
		t.Fatal(err)
	}
	first := machines.Definition{Base: machines.BasePrefix + "a", Revision: strings.Repeat("a", 64), Resources: machines.Resources{CPUs: 2, Memory: 3, Disk: 6}}
	second := machines.Definition{Base: machines.BasePrefix + "b", Revision: strings.Repeat("b", 64), Resources: machines.Resources{CPUs: 4, Memory: 5, Disk: 9}}
	ready := func(context.Context, guest.Exec) error { return nil }
	if err := driver.EnsureBase(ctx, first, metadata, disk, ready); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(disk, []byte("second image"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := driver.EnsureBase(ctx, second, metadata, disk, ready); err != nil {
		t.Fatal(err)
	}
	if len(server.instances) != 2 || len(server.deleted) != 0 {
		t.Fatalf("base replacement: instances=%d, deleted=%q", len(server.instances), server.deleted)
	}
	if err := driver.Create(ctx, "worker", "session-id", &machines.Selection{Name: "first", Definition: first}); err != nil {
		t.Fatal(err)
	}
	clone := server.instances["worker"]
	if server.clonedFrom != first.Base || clone.Config["limits.memory"] != "3GiB" || clone.Devices["root"]["size"] != "6GiB" || clone.Devices["root"]["size.state"] != "4GiB" {
		t.Fatalf("clone did not use its pin: %+v", clone)
	}
	if clone.Config[sessionKey] != "session-id" || clone.Config[machineKey] != first.Revision {
		t.Fatal("clone lost its record/machine identity")
	}
	before := maps.Clone(server.instances[first.Base].Config)
	if err := driver.EnsureBase(ctx, first, metadata, disk, ready); err == nil {
		t.Fatal("reused immutable base name for another image")
	}
	if !maps.Equal(before, server.instances[first.Base].Config) || len(server.deleted) != 0 {
		t.Fatal("failed preparation touched an existing base")
	}
}

func TestUnpreparedOrMismatchedBaseCannotLaunch(t *testing.T) {
	definition := machines.Definition{Base: machines.BasePrefix + "a", Revision: strings.Repeat("a", 64), Resources: machines.Resources{CPUs: 1, Memory: 1, Disk: 6}}
	server := &machineServer{instances: map[string]*api.Instance{definition.Base: {InstancePut: api.InstancePut{Config: map[string]string{machineKey: definition.Revision}}}}}
	driver := &Driver{server: server}
	selection := &machines.Selection{Name: "one", Definition: definition}
	if err := driver.Create(context.Background(), "worker", "id", selection); err == nil {
		t.Fatal("cloned a base before preparation completed")
	}
	server.instances[definition.Base].Config[baseReadyKey] = "true"
	server.instances[definition.Base].Config[machineKey] = strings.Repeat("b", 64)
	if err := driver.Create(context.Background(), "worker", "id", selection); err == nil {
		t.Fatal("ignored a mismatched pinned base")
	}
}
