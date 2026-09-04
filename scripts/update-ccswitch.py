#!/usr/bin/env python3
"""Safely backfill the active Codex auth/config into CC Switch's official provider."""

import argparse
import json
import shutil
import sqlite3
import sys
from datetime import datetime
from pathlib import Path


def fail(message):
    print(json.dumps({"ok": False, "message": message}, ensure_ascii=False))
    raise SystemExit(1)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True)
    parser.add_argument("--auth", required=True)
    parser.add_argument("--config", default="")
    args = parser.parse_args()

    db_path = Path(args.db).expanduser().resolve()
    auth_path = Path(args.auth).expanduser().resolve()
    config_path = Path(args.config).expanduser().resolve() if args.config else None
    if not db_path.is_file():
        print(json.dumps({"ok": True, "status": "skipped", "message": "未找到 CC Switch 数据库"}, ensure_ascii=False))
        return
    if not auth_path.is_file():
        fail("账号 auth.json 不存在")

    try:
        auth = json.loads(auth_path.read_text(encoding="utf-8"))
    except Exception as exc:
        fail(f"auth.json 不是有效 JSON：{exc}")
    config = config_path.read_text(encoding="utf-8") if config_path and config_path.is_file() else ""

    backup_dir = db_path.parent / "backups"
    backup_dir.mkdir(parents=True, exist_ok=True)
    backup_path = backup_dir / f"codex-token-dashboard-{datetime.now().strftime('%Y%m%d-%H%M%S')}.db"
    try:
        shutil.copy2(db_path, backup_path)
        con = sqlite3.connect(f"file:{db_path.as_posix()}?mode=rw", uri=True, timeout=5)
        con.execute("PRAGMA busy_timeout = 5000")
        con.execute("BEGIN IMMEDIATE")
        current = con.execute("select value from settings where key = 'currentProviderCodex'").fetchone()
        current_id = current[0] if current else ""
        provider = None
        if current_id:
            provider = con.execute(
                "select id, name, category from providers where app_type = 'codex' and id = ?",
                (current_id,),
            ).fetchone()
        if not provider or not (provider[2] == "official" or "official" in (provider[1] or "").lower() or "openai" in (provider[1] or "").lower()):
            provider = con.execute(
                "select id, name, category from providers "
                "where app_type = 'codex' and (category = 'official' or lower(name) like '%openai%') "
                "order by is_current desc, sort_index asc limit 1"
            ).fetchone()
        if not provider:
            con.rollback()
            con.close()
            fail("CC Switch 中没有可更新的 Codex 官方配置")

        row = con.execute("select settings_config from providers where id = ? and app_type = 'codex'", (provider[0],)).fetchone()
        if not row:
            con.rollback()
            con.close()
            fail("找不到 CC Switch 目标配置")
        settings = json.loads(row[0] or "{}")
        settings["auth"] = auth
        settings["config"] = config
        con.execute(
            "update providers set settings_config = ? where id = ? and app_type = 'codex'",
            (json.dumps(settings, ensure_ascii=False, separators=(",", ":")), provider[0]),
        )
        con.commit()
        con.close()
    except sqlite3.OperationalError as exc:
        try:
            con.rollback()
            con.close()
        except Exception:
            pass
        fail(f"CC Switch 数据库暂时不可写，请先关闭 CC Switch 后重试：{exc}")
    except Exception as exc:
        try:
            con.rollback()
            con.close()
        except Exception:
            pass
        fail(f"CC Switch 同步失败：{exc}")

    print(json.dumps({
        "ok": True,
        "status": "updated",
        "providerId": provider[0],
        "providerName": provider[1],
        "backupPath": str(backup_path),
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
