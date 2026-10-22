// Package incus backs sessions with Incus VMs in one project, each cloned from a warm base.
package incus

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	incus "github.com/lxc/incus/v7/client"
	"github.com/lxc/incus/v7/shared/api"

	"github.com/gshpychka/realm/packages/bay/internal/fault"
	"github.com/gshpychka/realm/packages/bay/internal/sessions"
)

const (
	// sessionKey holds the ID of the session an instance backs.
	sessionKey = "user.bay.session"
	vsockKey   = "volatile.vsock_id"
)

// Driver manages the instances backing sessions.
type Driver struct {
	server  incus.InstanceServer
	project string
	base    string
}

// Connect returns a driver for the instances in project, cloned from the instance named base.
func Connect(socket, project, base string) (*Driver, error) {
	server, err := incus.ConnectIncusUnix(socket, &incus.ConnectionArgs{UserAgent: "bay"})
	if err != nil {
		return nil, fmt.Errorf("connect to incus: %w", err)
	}
	return &Driver{server: server.UseProject(project), project: project, base: base}, nil
}

var _ sessions.Instances = (*Driver)(nil)

func (d *Driver) Create(ctx context.Context, name, sessionID string) error {
	op, err := d.server.CreateInstance(api.InstancesPost{
		Name:        name,
		Type:        api.InstanceTypeVM,
		Source:      api.InstanceSource{Type: "copy", Source: d.base, InstanceOnly: true},
		InstancePut: api.InstancePut{Config: map[string]string{sessionKey: sessionID}},
	})
	if err != nil {
		return fmt.Errorf("create instance %s: %w", name, err)
	}
	return wait(ctx, op, "create instance "+name)
}

func (d *Driver) Start(ctx context.Context, name string) (bool, error) {
	inst, _, err := d.server.GetInstance(name)
	if err != nil {
		return false, d.notFound(err, name)
	}
	op, err := d.server.UpdateInstanceState(name, api.InstanceStatePut{Action: "start", Stateful: inst.Stateful}, "")
	if err != nil {
		return false, fmt.Errorf("start instance %s: %w", name, err)
	}
	if err := wait(ctx, op, "start instance "+name); err != nil {
		return false, err
	}
	return inst.Stateful, d.awaitGuest(ctx, name)
}

// agentTimeout bounds the wait for a started VM's guest agent.
const agentTimeout = 3 * time.Minute

// awaitGuest returns once the guest agent runs commands.
func (d *Driver) awaitGuest(ctx context.Context, name string) error {
	ctx, cancel := context.WithTimeout(ctx, agentTimeout)
	defer cancel()
	for {
		err := d.Exec(ctx, name, []string{"true"}, nil, io.Discard)
		if err == nil {
			return nil
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("instance %s: guest agent did not answer: %w", name, err)
		case <-time.After(time.Second):
		}
	}
}

func (d *Driver) Suspend(ctx context.Context, name string) error {
	op, err := d.server.UpdateInstanceState(name, api.InstanceStatePut{Action: "stop", Stateful: true}, "")
	if err != nil {
		return fmt.Errorf("suspend instance %s: %w", name, err)
	}
	return wait(ctx, op, "suspend instance "+name)
}

func (d *Driver) Delete(ctx context.Context, name string) error {
	inst, _, err := d.server.GetInstance(name)
	if isNotFound(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("instance %s: %w", name, err)
	}
	if inst.StatusCode != api.Stopped {
		op, err := d.server.UpdateInstanceState(name, api.InstanceStatePut{Action: "stop", Timeout: -1, Force: true}, "")
		if err != nil {
			return fmt.Errorf("stop instance %s: %w", name, err)
		}
		if err := wait(ctx, op, "stop instance "+name); err != nil {
			return err
		}
	}
	op, err := d.server.DeleteInstance(name)
	if err != nil {
		return fmt.Errorf("delete instance %s: %w", name, err)
	}
	return wait(ctx, op, "delete instance "+name)
}

func (d *Driver) Status(ctx context.Context, name string) (sessions.Status, error) {
	inst, _, err := d.server.GetInstance(name)
	if isNotFound(err) {
		return sessions.InstanceAbsent, nil
	}
	if err != nil {
		return sessions.InstanceAbsent, fmt.Errorf("instance %s: %w", name, err)
	}
	return status(inst), nil
}

func (d *Driver) Statuses(ctx context.Context) (map[string]sessions.Status, error) {
	insts, err := d.server.GetInstances(api.InstanceTypeVM)
	if err != nil {
		return nil, fmt.Errorf("list instances: %w", err)
	}
	statuses := map[string]sessions.Status{}
	for _, inst := range insts {
		if inst.Config[sessionKey] != "" {
			statuses[inst.Name] = status(&inst)
		}
	}
	return statuses, nil
}

func (d *Driver) Snapshot(ctx context.Context, name, snapshot string) error {
	op, err := d.server.CreateInstanceSnapshot(name, api.InstanceSnapshotsPost{Name: snapshot, Stateful: true})
	if err != nil {
		return fmt.Errorf("snapshot instance %s: %w", name, err)
	}
	return wait(ctx, op, "snapshot instance "+name)
}

func (d *Driver) Snapshots(ctx context.Context, name string) ([]string, error) {
	snapshots, err := d.server.GetInstanceSnapshots(name)
	if err != nil {
		return nil, d.notFound(err, name)
	}
	slices.SortFunc(snapshots, func(a, b api.InstanceSnapshot) int { return a.CreatedAt.Compare(b.CreatedAt) })
	names := make([]string, 0, len(snapshots))
	for _, snapshot := range snapshots {
		names = append(names, snapshot.Name)
	}
	return names, nil
}

func (d *Driver) Restore(ctx context.Context, name, snapshot string) error {
	op, err := d.server.UpdateInstance(name, api.InstancePut{Restore: snapshot, Stateful: true}, "")
	if err != nil {
		return fmt.Errorf("restore instance %s to %s: %w", name, snapshot, d.notFound(err, name+"/"+snapshot))
	}
	if err := wait(ctx, op, "restore instance "+name); err != nil {
		return err
	}
	return d.awaitGuest(ctx, name)
}

func (d *Driver) Exec(ctx context.Context, name string, argv []string, stdin io.Reader, stdout io.Writer) error {
	stderr := &head{max: stderrLimit}
	args := &incus.InstanceExecArgs{Stdin: stdin, Stdout: stdout, Stderr: stderr, DataDone: make(chan bool)}
	op, err := d.server.ExecInstance(name, api.InstanceExecPost{Command: argv, WaitForWS: true}, args)
	if err != nil {
		return fmt.Errorf("exec in %s: %w", name, err)
	}
	if err := op.WaitContext(ctx); err != nil {
		return fmt.Errorf("exec in %s: %w", name, err)
	}
	<-args.DataDone
	code, ok := op.Get().Metadata["return"].(float64)
	if !ok {
		return fmt.Errorf("exec in %s: no exit status", name)
	}
	if code != 0 {
		return fmt.Errorf("exit status %d: %s", int(code), strings.TrimSpace(stderr.String()))
	}
	return nil
}

// stderrLimit is how much of a guest command's stderr an error carries; the guest decides how much it writes.
const stderrLimit = 64 << 10

// head keeps the first max bytes written to it and accepts the rest unread.
type head struct {
	buf       bytes.Buffer
	max       int
	truncated bool
}

func (h *head) Write(p []byte) (int, error) {
	n := len(p)
	if room := h.max - h.buf.Len(); n > room {
		h.truncated = true
		p = p[:max(room, 0)]
	}
	h.buf.Write(p)
	return n, nil
}

func (h *head) String() string {
	if h.truncated {
		return h.buf.String() + " (truncated)"
	}
	return h.buf.String()
}

func (d *Driver) Caller(ctx context.Context, cid uint32) (string, string, error) {
	insts, err := d.server.GetInstances(api.InstanceTypeVM)
	if err != nil {
		return "", "", fmt.Errorf("list instances: %w", err)
	}
	want := strconv.FormatUint(uint64(cid), 10)
	for _, inst := range insts {
		if inst.Config[vsockKey] == want && inst.StatusCode == api.Running && inst.Config[sessionKey] != "" {
			return inst.Name, inst.Config[sessionKey], nil
		}
	}
	return "", "", fmt.Errorf("%w: no running session has vsock context ID %d", fault.NotFound, cid)
}

func (d *Driver) AttachCommand(name string, argv []string) []string {
	return append([]string{"incus", "exec", "--project", d.project, name, "--"}, argv...)
}

func status(inst *api.Instance) sessions.Status {
	if inst.StatusCode == api.Stopped {
		return sessions.InstanceStopped
	}
	return sessions.InstanceRunning
}

func wait(ctx context.Context, op incus.Operation, what string) error {
	if err := op.WaitContext(ctx); err != nil {
		return fmt.Errorf("%s: %w", what, err)
	}
	return nil
}

func isNotFound(err error) bool {
	return err != nil && api.StatusErrorCheck(err, http.StatusNotFound)
}

func (d *Driver) notFound(err error, what string) error {
	if isNotFound(err) {
		return fmt.Errorf("%w: no instance %s", fault.NotFound, what)
	}
	return err
}
