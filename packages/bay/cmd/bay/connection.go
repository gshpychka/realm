package main

import (
	"context"
	"io"
	"strconv"
)

func (c *cli) connect(ctx context.Context, args []string) error {
	fs := newFlags()
	id := fs.String("id", "", "")
	generation := fs.String("generation", "", "")
	positional, err := parse(fs, args, 1, 1)
	if err != nil {
		return err
	}
	if *id == "" {
		return usageError("--id must name the session's ID from bay show --json")
	}
	var generations []uint64
	if *generation != "" {
		value, err := strconv.ParseUint(*generation, 10, 64)
		if err != nil {
			return usageError("--generation must be a non-negative integer from bay show --json")
		}
		generations = []uint64{value}
	}
	connection, err := c.client.Connect(ctx, positional[0], *id, generations...)
	if err != nil {
		return err
	}
	defer connection.Close()
	inputDone := make(chan error, 1)
	go func() {
		_, err := io.Copy(connection, c.stdin)
		if err != nil {
			connection.Close()
		} else {
			err = connection.CloseWrite()
		}
		inputDone <- err
	}()
	if _, err := io.Copy(c.stdout, connection); err != nil {
		return err
	}
	select {
	case err := <-inputDone:
		return err
	default:
		// The program can finish while stdin is still a live terminal. The
		// command exits without waiting for another keystroke from the operator.
		return nil
	}
}
