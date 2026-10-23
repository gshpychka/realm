package incus

import (
	"context"
	"errors"
	"io"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	incus "github.com/lxc/incus/v7/client"
	"github.com/lxc/incus/v7/shared/api"
)

type bridgeOperation struct {
	incus.Operation
	mu    sync.Mutex
	state api.Operation
	wait  func(context.Context) error
}

func (o *bridgeOperation) Get() api.Operation {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.state
}

func (o *bridgeOperation) WaitContext(ctx context.Context) error { return o.wait(ctx) }

func (o *bridgeOperation) complete() {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.state = completedBridgeOperation()
}

func completedBridgeOperation() api.Operation {
	return api.Operation{ID: "bridge-operation", StatusCode: api.Success, Metadata: map[string]any{"return": float64(0)}}
}

type bridgeServerState struct {
	operation   incus.Operation
	statusCalls atomic.Int32
	status      func(context.Context, string) (*api.Operation, string, error)
}

// Embed unused SDK methods so these regressions exercise the real Driver.Connect
// ownership boundary without a daemon, websocket transport, or guest machine.
type bridgeSDKServer struct {
	incus.InstanceServer
	state *bridgeServerState
	ctx   context.Context
}

func (s *bridgeSDKServer) WithContext(ctx context.Context) incus.InstanceServer {
	return &bridgeSDKServer{state: s.state, ctx: ctx}
}

func (s *bridgeSDKServer) GetInstance(string) (*api.Instance, string, error) {
	return &api.Instance{InstancePut: api.InstancePut{Config: map[string]string{sessionKey: "session-record"}}}, "", nil
}

func (s *bridgeSDKServer) ExecInstance(_ string, _ api.InstanceExecPost, args *incus.InstanceExecArgs) (incus.Operation, error) {
	close(args.DataDone)
	return s.state.operation, nil
}

func (s *bridgeSDKServer) GetOperation(id string) (*api.Operation, string, error) {
	s.state.statusCalls.Add(1)
	if s.state.status != nil {
		return s.state.status(s.ctx, id)
	}
	state := completedBridgeOperation()
	return &state, "", nil
}

func TestConnectKeepsSDKLifetimeUntilGuestExit(t *testing.T) {
	caller, cancelCaller := context.WithTimeout(context.Background(), time.Minute)
	defer cancelCaller()
	waiting := make(chan context.Context, 1)
	exited := make(chan struct{})
	operation := &bridgeOperation{state: api.Operation{ID: "bridge-operation", StatusCode: api.Running}}
	operation.wait = func(ctx context.Context) error {
		waiting <- ctx
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-exited:
			return nil
		}
	}
	var exitOnce sync.Once
	acknowledgeExit := func() {
		exitOnce.Do(func() {
			operation.complete()
			close(exited)
		})
	}
	t.Cleanup(acknowledgeExit)
	serverState := &bridgeServerState{operation: operation}
	driver := &Driver{server: &bridgeSDKServer{state: serverState}}
	finished := make(chan error, 1)
	go func() {
		finished <- driver.Connect(caller, "one", "session-record", []string{"bay-session", "operator", "session-record", "1", "environment", "stream"}, nil, io.Discard)
	}()
	var lifetime context.Context
	select {
	case lifetime = <-waiting:
	case <-time.After(time.Second):
		t.Fatal("driver did not begin waiting for guest exit")
	}
	if _, inheritedDeadline := lifetime.Deadline(); inheritedDeadline {
		t.Fatal("SDK operation inherited the caller's deadline")
	}
	cancelCaller()
	if err := lifetime.Err(); err != nil {
		t.Fatalf("caller cancellation ended the SDK operation lifetime: %v", err)
	}
	select {
	case err := <-finished:
		t.Fatalf("driver returned before the guest acknowledged exit: %v", err)
	case <-time.After(30 * time.Millisecond):
	}
	acknowledgeExit()
	select {
	case err := <-finished:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("driver lost caller cancellation after the genuine exit: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("driver did not release its bridge after genuine guest exit")
	}
	if calls := serverState.statusCalls.Load(); calls != 0 {
		t.Fatalf("final SDK operation required %d unnecessary status requests", calls)
	}
}

func TestConnectConfirmsNonfinalListenerWakeIndependentlyOfCaller(t *testing.T) {
	caller, cancelCaller := context.WithCancel(context.Background())
	defer cancelCaller()
	operation := &bridgeOperation{
		state: api.Operation{ID: "bridge-operation", StatusCode: api.Running},
		wait:  func(context.Context) error { return errors.New("lost event listener") },
	}
	type statusRequest struct {
		ctx context.Context
		id  string
	}
	requested := make(chan statusRequest, 1)
	confirmed := make(chan struct{})
	var confirmOnce sync.Once
	confirm := func() { confirmOnce.Do(func() { close(confirmed) }) }
	t.Cleanup(confirm)
	serverState := &bridgeServerState{
		operation: operation,
		status: func(ctx context.Context, id string) (*api.Operation, string, error) {
			requested <- statusRequest{ctx: ctx, id: id}
			select {
			case <-ctx.Done():
				return nil, "", ctx.Err()
			case <-confirmed:
				state := completedBridgeOperation()
				return &state, "", nil
			}
		},
	}
	driver := &Driver{server: &bridgeSDKServer{state: serverState}}
	finished := make(chan error, 1)
	go func() {
		finished <- driver.Connect(caller, "one", "session-record", []string{"bay-session", "operator", "session-record", "1", "environment", "stream"}, nil, io.Discard)
	}()
	var request statusRequest
	select {
	case request = <-requested:
	case err := <-finished:
		t.Fatalf("nonfinal listener wake was accepted as guest exit: %v", err)
	case <-time.After(time.Second):
		t.Fatal("driver did not query the server after losing its operation listener")
	}
	if request.id != "bridge-operation" {
		t.Fatalf("queried a different operation: %q", request.id)
	}
	deadline, bounded := request.ctx.Deadline()
	if !bounded || time.Until(deadline) <= 0 || time.Until(deadline) > 5*time.Second {
		t.Fatal("status confirmation did not receive its own bounded request context")
	}
	cancelCaller()
	if err := request.ctx.Err(); err != nil {
		t.Fatalf("caller cancellation invalidated the independent guest status request: %v", err)
	}
	select {
	case err := <-finished:
		t.Fatalf("driver released its bridge before the server's final receipt: %v", err)
	case <-time.After(30 * time.Millisecond):
	}
	confirm()
	select {
	case err := <-finished:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("driver lost caller cancellation after server confirmation: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("final server confirmation did not release the bridge")
	}
	if calls := serverState.statusCalls.Load(); calls != 1 {
		t.Fatalf("made %d status requests, want one acknowledged request", calls)
	}
	if request.ctx.Err() == nil {
		t.Fatal("finished status request context was not released")
	}
}
