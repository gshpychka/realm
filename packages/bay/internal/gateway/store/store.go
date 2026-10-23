// Package store keeps threads and their messages in a SQLite database.
package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gshpychka/realm/packages/bay/internal/fault"
	"github.com/gshpychka/realm/packages/bay/internal/gateway"
	"github.com/gshpychka/realm/packages/bay/internal/messages"
	_ "modernc.org/sqlite"
)

const subjectRunes = 80

// Transactions take the write lock at BEGIN (_txlock=immediate), where busy_timeout waits for it.
const dsnOptions = "?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)&_txlock=immediate"

// sent and read_at count nanoseconds since the Unix epoch; read_at is NULL until the recipient reads the message.
const schema = `
CREATE TABLE IF NOT EXISTS threads (
	id      INTEGER PRIMARY KEY AUTOINCREMENT,
	subject TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS participants (
	seq    INTEGER PRIMARY KEY AUTOINCREMENT,
	thread INTEGER NOT NULL REFERENCES threads (id),
	id     TEXT NOT NULL,
	name   TEXT NOT NULL,
	UNIQUE (thread, id)
);
CREATE TABLE IF NOT EXISTS messages (
	id        INTEGER PRIMARY KEY AUTOINCREMENT,
	thread    INTEGER NOT NULL REFERENCES threads (id),
	from_id   TEXT NOT NULL,
	from_name TEXT NOT NULL,
	to_id     TEXT NOT NULL,
	to_name   TEXT NOT NULL,
	body      TEXT NOT NULL,
	sent      INTEGER NOT NULL,
	read_at   INTEGER
);
CREATE INDEX IF NOT EXISTS messages_thread ON messages (thread);
`

// Store keeps threads, the participants in each and their messages.
type Store struct {
	db *sql.DB
}

// Open opens the database at path, creating it and its tables when they are missing.
func Open(path string) (*Store, error) {
	db, err := sql.Open("sqlite", "file:"+path+dsnOptions)
	if err != nil {
		return nil, fmt.Errorf("open message store: %w", err)
	}
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("open message store: %w", err)
	}
	return &Store{db: db}, nil
}

// Close releases the database.
func (s *Store) Close() error {
	return s.db.Close()
}

// Send delivers a message and returns it. Thread 0 starts a new thread, titled with the first line of subject, or of
// body when subject is blank, cut to 80 runes. Any other thread must exist, and only its participants and the
// operator may write to it. Within a thread a name stands for the participant holding it, so a recipient sharing a
// participant's name under another ID is a fault.Conflict. Sender and recipient are participants of the thread
// afterwards.
func (s *Store) Send(ctx context.Context, from, to gateway.Participant, thread int64, subject, body string) (messages.Message, error) {
	if err := validate(from, to, body); err != nil {
		return messages.Message{}, err
	}
	return inTx(ctx, s.db, func(tx *sql.Tx) (messages.Message, error) {
		if thread == 0 {
			res, err := tx.ExecContext(ctx, `INSERT INTO threads (subject) VALUES (?)`, subjectOf(subject, body))
			if err != nil {
				return messages.Message{}, err
			}
			if thread, err = res.LastInsertId(); err != nil {
				return messages.Message{}, err
			}
		} else {
			if err := authorize(ctx, tx, thread, from); err != nil {
				return messages.Message{}, err
			}
			if err := checkName(ctx, tx, thread, to); err != nil {
				return messages.Message{}, err
			}
		}
		for _, p := range []gateway.Participant{from, to} {
			if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO participants (thread, id, name) VALUES (?, ?, ?)`, thread, p.ID, p.Name); err != nil {
				return messages.Message{}, err
			}
		}
		sent := time.Now().UnixNano()
		res, err := tx.ExecContext(ctx,
			`INSERT INTO messages (thread, from_id, from_name, to_id, to_name, body, sent) VALUES (?, ?, ?, ?, ?, ?, ?)`,
			thread, from.ID, from.Name, to.ID, to.Name, body, sent)
		if err != nil {
			return messages.Message{}, err
		}
		id, err := res.LastInsertId()
		if err != nil {
			return messages.Message{}, err
		}
		return messages.Message{ID: id, Thread: thread, From: from.Name, To: to.Name, Body: body, Sent: toTime(sent)}, nil
	})
}

// Inbox returns the threads holding messages to viewer that viewer has not read, most recently updated first.
func (s *Store) Inbox(ctx context.Context, viewer gateway.Participant) ([]messages.Thread, error) {
	return inTx(ctx, s.db, func(tx *sql.Tx) ([]messages.Thread, error) {
		return queryThreads(ctx, tx, threadQuery("", "HAVING unread > 0"), viewer.ID)
	})
}

// Threads returns every thread, most recently updated first. Only the operator may list every thread.
func (s *Store) Threads(ctx context.Context, viewer gateway.Participant) ([]messages.Thread, error) {
	if viewer.ID != messages.Operator {
		return nil, fmt.Errorf("%w: only the operator lists every thread", fault.Forbidden)
	}
	return inTx(ctx, s.db, func(tx *sql.Tx) ([]messages.Thread, error) {
		return queryThreads(ctx, tx, threadQuery("", ""), viewer.ID)
	})
}

// Conversation returns a page, oldest first, before the given message ID (0 for the
// latest page). Only returned messages to viewer are marked read. The thread's
// Unread counts those this call marks; Earlier counts messages before this page.
func (s *Store) Conversation(ctx context.Context, viewer gateway.Participant, thread, before int64) (messages.Conversation, error) {
	if before < 0 {
		return messages.Conversation{}, fmt.Errorf("%w: before must not be negative", fault.Invalid)
	}
	return inTx(ctx, s.db, func(tx *sql.Tx) (messages.Conversation, error) {
		if err := authorize(ctx, tx, thread, viewer); err != nil {
			return messages.Conversation{}, err
		}
		threads, err := queryThreads(ctx, tx, threadQuery("WHERE t.id = ?", ""), viewer.ID, thread)
		if err != nil {
			return messages.Conversation{}, err
		}
		msgs, err := latestMessages(ctx, tx, thread, before)
		if err != nil {
			return messages.Conversation{}, err
		}
		earlier := 0
		threads[0].Unread = 0
		if len(msgs) > 0 {
			oldest, newest := msgs[0].ID, msgs[len(msgs)-1].ID
			if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM messages WHERE thread = ? AND id < ?`, thread, oldest).Scan(&earlier); err != nil {
				return messages.Conversation{}, err
			}
			res, err := tx.ExecContext(ctx, `UPDATE messages SET read_at = ? WHERE thread = ? AND to_id = ? AND read_at IS NULL AND id BETWEEN ? AND ?`,
				time.Now().UnixNano(), thread, viewer.ID, oldest, newest)
			if err != nil {
				return messages.Conversation{}, err
			}
			marked, err := res.RowsAffected()
			if err != nil {
				return messages.Conversation{}, err
			}
			threads[0].Unread = int(marked)
		}
		return messages.Conversation{Thread: threads[0], Messages: msgs, Earlier: earlier}, nil
	})
}

func inTx[T any](ctx context.Context, db *sql.DB, fn func(*sql.Tx) (T, error)) (T, error) {
	var zero T
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return zero, err
	}
	defer tx.Rollback()
	v, err := fn(tx)
	if err != nil {
		return zero, err
	}
	if err := tx.Commit(); err != nil {
		return zero, err
	}
	return v, nil
}

func validate(from, to gateway.Participant, body string) error {
	switch {
	case from.ID == "" || from.Name == "" || to.ID == "" || to.Name == "":
		return fmt.Errorf("%w: a message needs a sender and a recipient", fault.Invalid)
	case from.ID == to.ID:
		return fmt.Errorf("%w: a message needs a recipient other than its sender", fault.Invalid)
	case len(body) > messages.MaxBody:
		return fmt.Errorf("%w: a message body is at most %d bytes", fault.Invalid, messages.MaxBody)
	case strings.TrimSpace(body) == "":
		return fmt.Errorf("%w: a message needs a body", fault.Invalid)
	}
	return nil
}

// authorize requires thread to exist and who to take part in it, or to be the operator.
func authorize(ctx context.Context, tx *sql.Tx, thread int64, who gateway.Participant) error {
	var participant bool
	err := tx.QueryRowContext(ctx,
		`SELECT EXISTS (SELECT 1 FROM participants WHERE thread = ? AND id = ?) FROM threads WHERE id = ?`,
		thread, who.ID, thread).Scan(&participant)
	if errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("%w: thread %d", fault.NotFound, thread)
	}
	if err != nil {
		return err
	}
	if !participant && who.ID != messages.Operator {
		return fmt.Errorf("%w: thread %d", fault.Forbidden, thread)
	}
	return nil
}

// checkName requires any participant of thread holding who's name to be who.
func checkName(ctx context.Context, tx *sql.Tx, thread int64, who gateway.Participant) error {
	var held bool
	err := tx.QueryRowContext(ctx,
		`SELECT EXISTS (SELECT 1 FROM participants WHERE thread = ? AND name = ? AND id <> ?)`,
		thread, who.Name, who.ID).Scan(&held)
	if err != nil {
		return err
	}
	if held {
		return fmt.Errorf("%w: %s in thread %d is an earlier session", fault.Conflict, who.Name, thread)
	}
	return nil
}

func subjectOf(subject, body string) string {
	text := strings.TrimSpace(subject)
	if text == "" {
		text = strings.TrimSpace(body)
	}
	line, _, _ := strings.Cut(text, "\n")
	line = strings.TrimSpace(line)
	if utf8.RuneCountInString(line) > subjectRunes {
		line = string([]rune(line)[:subjectRunes])
	}
	return line
}

// threadQuery selects each thread with its message count, the messages to a viewer still unread and its latest
// message time, most recently updated first. Its first argument is the viewer's ID, followed by those of where. Every
// thread holds a message, because Send creates a thread together with its first.
func threadQuery(where, having string) string {
	return `SELECT t.id, t.subject, COUNT(*), COUNT(*) FILTER (WHERE m.to_id = ? AND m.read_at IS NULL) AS unread, MAX(m.sent)
		FROM threads t JOIN messages m ON m.thread = t.id ` + where + ` GROUP BY t.id ` + having + ` ORDER BY MAX(m.id) DESC`
}

func queryThreads(ctx context.Context, tx *sql.Tx, query string, args ...any) ([]messages.Thread, error) {
	threads, err := selectThreads(ctx, tx, query, args...)
	if err != nil {
		return nil, err
	}
	for i := range threads {
		if threads[i].Participants, err = participantNames(ctx, tx, threads[i].ID); err != nil {
			return nil, err
		}
	}
	return threads, nil
}

func selectThreads(ctx context.Context, tx *sql.Tx, query string, args ...any) ([]messages.Thread, error) {
	rows, err := tx.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	threads := []messages.Thread{}
	for rows.Next() {
		var t messages.Thread
		var updated int64
		if err := rows.Scan(&t.ID, &t.Subject, &t.Messages, &t.Unread, &updated); err != nil {
			return nil, err
		}
		t.Updated = toTime(updated)
		threads = append(threads, t)
	}
	return threads, rows.Err()
}

// participantNames returns the names of a thread's participants in the order they joined.
func participantNames(ctx context.Context, tx *sql.Tx, thread int64) ([]string, error) {
	rows, err := tx.QueryContext(ctx, `SELECT name FROM participants WHERE thread = ? ORDER BY seq`, thread)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	names := []string{}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		names = append(names, name)
	}
	return names, rows.Err()
}

// latestMessages returns the thread's newest message and as many before it as fit in messages.MaxConversation body
// bytes, oldest first.
func latestMessages(ctx context.Context, tx *sql.Tx, thread, before int64) ([]messages.Message, error) {
	query := `SELECT id, from_name, to_name, body, sent FROM messages WHERE thread = ?`
	args := []any{thread}
	if before > 0 {
		query += ` AND id < ?`
		args = append(args, before)
	}
	rows, err := tx.QueryContext(ctx, query+` ORDER BY id DESC`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	msgs := []messages.Message{}
	budget := messages.MaxConversation
	for rows.Next() {
		m := messages.Message{Thread: thread}
		var sent int64
		if err := rows.Scan(&m.ID, &m.From, &m.To, &m.Body, &sent); err != nil {
			return nil, err
		}
		if len(msgs) > 0 && len(m.Body) > budget {
			break
		}
		budget -= len(m.Body)
		m.Sent = toTime(sent)
		msgs = append(msgs, m)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	slices.Reverse(msgs)
	return msgs, nil
}

func toTime(nanos int64) time.Time {
	return time.Unix(0, nanos).UTC()
}
