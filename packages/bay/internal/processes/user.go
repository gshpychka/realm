package processes

import (
	"errors"
	"os"
	"os/user"
	"strconv"
	"syscall"
)

// Credentials resolves the configured account once, before any user command.
// The same-account case does not need privileged setgroups in source tests.
func Credentials(name string) (*syscall.Credential, error) {
	u, err := user.Lookup(name)
	if err != nil {
		return nil, err
	}
	uid, err := strconv.ParseUint(u.Uid, 10, 32)
	if err != nil {
		return nil, err
	}
	if uid == 0 {
		return nil, errors.New("operator commands require an unprivileged session user")
	}
	gid, err := strconv.ParseUint(u.Gid, 10, 32)
	if err != nil {
		return nil, err
	}
	if int(uid) == os.Geteuid() && int(gid) == os.Getegid() {
		return nil, nil
	}
	groups, err := u.GroupIds()
	if err != nil {
		return nil, err
	}
	credential := &syscall.Credential{Uid: uint32(uid), Gid: uint32(gid)}
	for _, group := range groups {
		id, err := strconv.ParseUint(group, 10, 32)
		if err != nil {
			return nil, err
		}
		credential.Groups = append(credential.Groups, uint32(id))
	}
	return credential, nil
}
