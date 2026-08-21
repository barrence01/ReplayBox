use crate::models::{Recording, Session};
use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;

/// Opens (or creates) the catalog database and applies schema migrations.
pub fn open_db(path: &Path) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    conn.execute_batch(
        "
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            started_at TEXT NOT NULL,
            ended_at TEXT,
            game_process TEXT
        );

        CREATE TABLE IF NOT EXISTS recordings (
            id TEXT PRIMARY KEY,
            path TEXT UNIQUE NOT NULL,
            filename TEXT NOT NULL,
            dir TEXT NOT NULL,
            size_bytes INTEGER,
            duration_ms REAL,
            width INTEGER,
            height INTEGER,
            video_codec TEXT,
            audio_codec TEXT,
            is_vfr INTEGER NOT NULL DEFAULT 0,
            created_at TEXT,
            modified_at TEXT,
            thumbnail_path TEXT,
            session_id TEXT,
            indexed_at TEXT NOT NULL,
            FOREIGN KEY(session_id) REFERENCES sessions(id)
        );

        CREATE INDEX IF NOT EXISTS idx_recordings_session ON recordings(session_id);
        CREATE INDEX IF NOT EXISTS idx_recordings_modified ON recordings(modified_at);
        ",
    )
    .map_err(|e| e.to_string())?;
    Ok(conn)
}

pub fn upsert_recording(conn: &Connection, rec: &Recording) -> Result<(), String> {
    conn.execute(
        "
        INSERT INTO recordings (
            id, path, filename, dir, size_bytes, duration_ms, width, height,
            video_codec, audio_codec, is_vfr, created_at, modified_at,
            thumbnail_path, session_id, indexed_at
        ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)
        ON CONFLICT(path) DO UPDATE SET
            filename=excluded.filename,
            dir=excluded.dir,
            size_bytes=excluded.size_bytes,
            duration_ms=excluded.duration_ms,
            width=excluded.width,
            height=excluded.height,
            video_codec=excluded.video_codec,
            audio_codec=excluded.audio_codec,
            is_vfr=excluded.is_vfr,
            created_at=excluded.created_at,
            modified_at=excluded.modified_at,
            thumbnail_path=COALESCE(excluded.thumbnail_path, recordings.thumbnail_path),
            session_id=COALESCE(excluded.session_id, recordings.session_id),
            indexed_at=excluded.indexed_at
        ",
        params![
            rec.id,
            rec.path,
            rec.filename,
            rec.dir,
            rec.size_bytes,
            rec.duration_ms,
            rec.width,
            rec.height,
            rec.video_codec,
            rec.audio_codec,
            rec.is_vfr as i64,
            rec.created_at,
            rec.modified_at,
            rec.thumbnail_path,
            rec.session_id,
            rec.indexed_at,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn get_recording_by_id(conn: &Connection, id: &str) -> Result<Option<Recording>, String> {
    conn.query_row(
        "SELECT id, path, filename, dir, size_bytes, duration_ms, width, height,
                video_codec, audio_codec, is_vfr, created_at, modified_at,
                thumbnail_path, session_id, indexed_at
         FROM recordings WHERE id = ?1",
        params![id],
        map_recording,
    )
    .optional()
    .map_err(|e| e.to_string())
}

pub fn get_recording_by_path(conn: &Connection, path: &str) -> Result<Option<Recording>, String> {
    conn.query_row(
        "SELECT id, path, filename, dir, size_bytes, duration_ms, width, height,
                video_codec, audio_codec, is_vfr, created_at, modified_at,
                thumbnail_path, session_id, indexed_at
         FROM recordings WHERE path = ?1",
        params![path],
        map_recording,
    )
    .optional()
    .map_err(|e| e.to_string())
}

pub fn list_recordings(conn: &Connection, query: Option<&str>) -> Result<Vec<Recording>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, path, filename, dir, size_bytes, duration_ms, width, height,
                    video_codec, audio_codec, is_vfr, created_at, modified_at,
                    thumbnail_path, session_id, indexed_at
             FROM recordings
             WHERE (?1 IS NULL OR filename LIKE '%' || ?1 || '%' OR dir LIKE '%' || ?1 || '%')
             ORDER BY COALESCE(modified_at, indexed_at) DESC",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map(params![query], map_recording)
        .map_err(|e| e.to_string())?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

pub fn list_session_recordings(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<Recording>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, path, filename, dir, size_bytes, duration_ms, width, height,
                    video_codec, audio_codec, is_vfr, created_at, modified_at,
                    thumbnail_path, session_id, indexed_at
             FROM recordings
             WHERE session_id = ?1
             ORDER BY COALESCE(modified_at, indexed_at) DESC",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map(params![session_id], map_recording)
        .map_err(|e| e.to_string())?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

pub fn delete_recording_by_path(conn: &Connection, path: &str) -> Result<(), String> {
    let deleted = conn
        .execute("DELETE FROM recordings WHERE path = ?1", params![path])
        .map_err(|e| e.to_string())?;
    if deleted > 0 {
        return Ok(());
    }

    let candidate = Path::new(path);
    if let Ok(canonical) = candidate.canonicalize() {
        let canon_str = canonical.to_string_lossy();
        if canon_str != path {
            conn.execute(
                "DELETE FROM recordings WHERE path = ?1",
                params![canon_str.as_ref()],
            )
            .map_err(|e| e.to_string())?;
        }
    } else if let (Some(parent), Some(name)) = (candidate.parent(), candidate.file_name()) {
        let parent_s = parent.to_string_lossy();
        let name_s = name.to_string_lossy();
        conn.execute(
            "DELETE FROM recordings WHERE filename = ?1 AND dir = ?2",
            params![name_s.as_ref(), parent_s.as_ref()],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Remove a recording by id and return its thumbnail path if any.
pub fn delete_recording_by_id(conn: &Connection, id: &str) -> Result<Option<String>, String> {
    let thumb: Option<String> = conn
        .query_row(
            "SELECT thumbnail_path FROM recordings WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .flatten();

    conn.execute("DELETE FROM recordings WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(thumb)
}

pub fn insert_session(conn: &Connection, session: &Session) -> Result<(), String> {
    conn.execute(
        "INSERT INTO sessions (id, started_at, ended_at, game_process) VALUES (?1,?2,?3,?4)",
        params![
            session.id,
            session.started_at,
            session.ended_at,
            session.game_process
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn end_session(conn: &Connection, id: &str, ended_at: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE sessions SET ended_at = ?1 WHERE id = ?2",
        params![ended_at, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn get_session(conn: &Connection, id: &str) -> Result<Option<Session>, String> {
    conn.query_row(
        "SELECT id, started_at, ended_at, game_process FROM sessions WHERE id = ?1",
        params![id],
        |row| {
            Ok(Session {
                id: row.get(0)?,
                started_at: row.get(1)?,
                ended_at: row.get(2)?,
                game_process: row.get(3)?,
            })
        },
    )
    .optional()
    .map_err(|e| e.to_string())
}

fn map_recording(row: &rusqlite::Row<'_>) -> rusqlite::Result<Recording> {
    Ok(Recording {
        id: row.get(0)?,
        path: row.get(1)?,
        filename: row.get(2)?,
        dir: row.get(3)?,
        size_bytes: row.get(4)?,
        duration_ms: row.get(5)?,
        width: row.get(6)?,
        height: row.get(7)?,
        video_codec: row.get(8)?,
        audio_codec: row.get(9)?,
        is_vfr: row.get::<_, i64>(10)? != 0,
        created_at: row.get(11)?,
        modified_at: row.get(12)?,
        thumbnail_path: row.get(13)?,
        session_id: row.get(14)?,
        indexed_at: row.get(15)?,
    })
}
