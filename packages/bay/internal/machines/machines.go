// Package machines describes declared guest environments and their immutable revisions.
package machines

import (
	"fmt"
	"regexp"
	"strings"
)

const Default = "default"

// BasePrefix reserves prepared bases, including revisions no longer in the catalog.
const BasePrefix = "bay-base-"

// Resources are per-instance limits. Memory and disk are measured in GiB.
type Resources struct {
	CPUs   int `json:"cpus"`
	Memory int `json:"memory"`
	Disk   int `json:"disk"`
}

// Definition is declared by the host. Base is prepared before sessions can use it.
// Its identity includes image and resource geometry; a revision is never replaced.
type Definition struct {
	Base      string    `json:"base"`
	Revision  string    `json:"revision"`
	Resources Resources `json:"resources"`
}

// Selection is a session's pinned copy, retained when the catalog changes.
type Selection struct {
	Name string `json:"name"`
	Definition
}

var (
	namePattern     = regexp.MustCompile(`^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$`)
	revisionPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
)

func (d Definition) Validate(name string) error {
	if !namePattern.MatchString(name) {
		return fmt.Errorf("invalid machine name %q", name)
	}
	if !strings.HasPrefix(d.Base, BasePrefix) || !namePattern.MatchString(d.Base) {
		return fmt.Errorf("machine %s: base must be a DNS label starting with %s", name, BasePrefix)
	}
	if !revisionPattern.MatchString(d.Revision) {
		return fmt.Errorf("machine %s: revision must be a lowercase SHA-256 digest", name)
	}
	if d.Resources.CPUs <= 0 || d.Resources.Memory <= 0 || d.Resources.Disk <= 0 {
		return fmt.Errorf("machine %s: cpus, memory and disk must be positive", name)
	}
	return nil
}

func ValidateCatalog(catalog map[string]Definition) error {
	if _, ok := catalog[Default]; !ok {
		return fmt.Errorf("machine catalog needs a default machine")
	}
	bases := map[string]Definition{}
	for name, definition := range catalog {
		if err := definition.Validate(name); err != nil {
			return err
		}
		if previous, ok := bases[definition.Base]; ok && previous != definition {
			return fmt.Errorf("machine %s reuses base %s for a different definition", name, definition.Base)
		}
		bases[definition.Base] = definition
	}
	return nil
}
