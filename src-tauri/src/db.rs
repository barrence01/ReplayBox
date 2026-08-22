use crate::models::Recording;
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
        CREATE INDEX IF NOT EXISTS idx_recordings_dir ON recordings(dir);
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

pub fn list_recordings_under_dir(
    conn: &Connection,
    dir_prefix: &str,
) -> Result<Vec<Recording>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, path, filename, dir, size_bytes, duration_ms, width, height,
                    video_codec, audio_codec, is_vfr, created_at, modified_at,
                    thumbnail_path, session_id, indexed_at
             FROM recordings
             WHERE dir = ?1 OR dir LIKE ?1 || '/%'
             ORDER BY COALESCE(modified_at, indexed_at) DESC",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map(params![dir_prefix], map_recording)
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::Recording;

    fn sample_recording(id: &str, path: &str) -> Recording {
        Recording {
            id: id.to_string(),
            path: path.to_string(),
            filename: Path::new(path)
                .file_name()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            dir: Path::new(path)
                .parent()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            size_bytes: Some(100),
            duration_ms: Some(1500.0),
            width: Some(1280),
            height: Some(720),
            video_codec: Some("h264".into()),
            audio_codec: Some("aac".into()),
            is_vfr: false,
            created_at: Some("2024-01-01T00:00:00Z".into()),
            modified_at: Some("2024-01-02T00:00:00Z".into()),
            thumbnail_path: None,
            session_id: None,
            indexed_at: "2024-01-03T00:00:00Z".into(),
        }
    }

    #[test]
    fn open_db_upsert_get_list_and_delete() {
        let dir = tempfile::tempdir().unwrap();
        let db_file = dir.path().join("test.db");
        let conn = open_db(&db_file).unwrap();

        let rec = sample_recording("r1", "/videos/clip.mp4");
        upsert_recording(&conn, &rec).unwrap();

        let by_id = get_recording_by_id(&conn, "r1").unwrap().unwrap();
        assert_eq!(by_id.filename, "clip.mp4");
        assert_eq!(by_id.duration_ms, Some(1500.0));

        let by_path = get_recording_by_path(&conn, "/videos/clip.mp4")
            .unwrap()
            .unwrap();
        assert_eq!(by_path.id, "r1");

        let listed = list_recordings(&conn, Some("clip")).unwrap();
        assert_eq!(listed.len(), 1);

        let thumb = delete_recording_by_id(&conn, "r1").unwrap();
        assert!(thumb.is_none());
        assert!(get_recording_by_id(&conn, "r1").unwrap().is_none());
    }

    #[test]
    fn delete_recording_by_path_removes_row() {
        let dir = tempfile::tempdir().unwrap();
        let conn = open_db(&dir.path().join("test.db")).unwrap();
        upsert_recording(&conn, &sample_recording("r3", "/videos/gone.mp4")).unwrap();
        delete_recording_by_path(&conn, "/videos/gone.mp4").unwrap();
        assert!(get_recording_by_path(&conn, "/videos/gone.mp4")
            .unwrap()
            .is_none());
    }
}
