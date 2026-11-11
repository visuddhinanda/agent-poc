#!/usr/bin/env python3
"""从 Gmail 下载每日访问报告邮件，保存到 data/raw/mail/，然后把邮件从收件箱归档。

只用标准库（imaplib / email），不需要装依赖。凭据与筛选条件读 agent-tuning/.env，见 agent-tuning/.env.example。

用法：
    python3 sources/mail/fetch_mail.py --list            # 只看收件箱最近的邮件（发件人/标题），用来写 MAIL_QUERY
    python3 sources/mail/fetch_mail.py                   # 下载收件箱里所有匹配的邮件，并归档
    python3 sources/mail/fetch_mail.py --dry-run         # 只列出会下载哪些，不下载不归档
    python3 sources/mail/fetch_mail.py --no-archive      # 下载但留在收件箱
    python3 sources/mail/fetch_mail.py --all-mail        # 也搜已归档的邮件（补历史数据；已下载过的跳过）
    python3 sources/mail/fetch_mail.py --since 2026-08-09  # 只处理报告日期不早于该日的

以下命令在 agent-tuning/ 下运行。

保存结构（data/raw/ 已 gitignore，含用户数据）：
    data/raw/mail/<日期>_<短id>/message.eml       原始邮件
    data/raw/mail/<日期>_<短id>/meta.json         发件人、标题、日期、Message-ID、附件列表
    data/raw/mail/<日期>_<短id>/body.txt|body.html 正文
    data/raw/mail/<日期>_<短id>/attachments/...    附件
    data/raw/mail/index.jsonl                      已下载邮件索引（按 Message-ID 去重）
"""

from __future__ import annotations

import argparse
import email
import email.policy
import hashlib
import imaplib
import json
import os
import re
import sys
from datetime import datetime, timezone
from email.message import EmailMessage
from email.utils import parsedate_to_datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]  # agent-tuning/
RAW_DIR = ROOT / "data" / "raw" / "mail"
INDEX_FILE = RAW_DIR / "index.jsonl"

# Gmail 所有邮件的特殊文件夹属性（文件夹名随界面语言变化，按属性找）
ALL_MAIL_FLAG = "\\All"


def load_env(path: Path) -> None:
    """读 KEY=VALUE 格式的 .env，不覆盖已有环境变量。"""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        os.environ.setdefault(key.strip(), value)


def die(msg: str) -> None:
    print(f"错误：{msg}", file=sys.stderr)
    sys.exit(1)


def connect() -> imaplib.IMAP4_SSL:
    user = os.environ.get("GMAIL_USER", "").strip()
    password = os.environ.get("GMAIL_APP_PASSWORD", "").replace(" ", "")
    if not user or not password:
        die("请在 agent-tuning/.env 里填写 GMAIL_USER 和 GMAIL_APP_PASSWORD（见 README.md）")
    host = os.environ.get("IMAP_HOST", "imap.gmail.com")
    port = int(os.environ.get("IMAP_PORT", "993"))
    imap = imaplib.IMAP4_SSL(host, port)
    try:
        imap.login(user, password)
    except imaplib.IMAP4.error as e:
        die(f"登录失败：{e}。确认用的是「应用专用密码」而不是 Gmail 登录密码。")
    return imap


def find_all_mail_folder(imap: imaplib.IMAP4_SSL) -> str:
    typ, data = imap.list()
    for raw in data or []:
        line = raw.decode("utf-8", "replace") if isinstance(raw, bytes) else str(raw)
        if ALL_MAIL_FLAG in line.split(")")[0]:
            m = re.search(r'"([^"]+)"\s*$', line) or re.search(r"(\S+)\s*$", line)
            if m:
                return m.group(1)
    die("找不到 Gmail「所有邮件」文件夹（IMAP 设置里可能把它隐藏了）")
    return ""


def select(imap: imaplib.IMAP4_SSL, folder: str, readonly: bool) -> None:
    typ, data = imap.select(f'"{folder}"', readonly=readonly)
    if typ != "OK":
        die(f"打开文件夹 {folder} 失败：{data}")


def search(imap: imaplib.IMAP4_SSL, query: str) -> list[bytes]:
    """用 Gmail 搜索语法（X-GM-RAW）搜索当前文件夹，返回 UID 列表（旧→新）。"""
    imap.literal = query.encode("utf-8")
    typ, data = imap.uid("SEARCH", "CHARSET", "UTF-8", "X-GM-RAW")
    if typ != "OK":
        die(f"搜索失败：{data}")
    return data[0].split() if data and data[0] else []


def fetch_raw(imap: imaplib.IMAP4_SSL, uid: bytes) -> bytes:
    typ, data = imap.uid("FETCH", uid, "(BODY.PEEK[])")
    if typ != "OK":
        die(f"下载 UID {uid!r} 失败：{data}")
    for part in data:
        if isinstance(part, tuple):
            return part[1]
    die(f"UID {uid!r} 没有返回邮件内容")
    return b""


def fetch_headers(imap: imaplib.IMAP4_SSL, uids: list[bytes]) -> list[tuple[bytes, EmailMessage]]:
    """取一批邮件的头部，返回 [(uid, 头部)]，按 uid 从旧到新。"""
    if not uids:
        return []
    typ, data = imap.uid(
        "FETCH", b",".join(uids), "(BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID)])"
    )
    out = []
    for part in data or []:
        if isinstance(part, tuple):
            m = re.search(rb"UID (\d+)", part[0])
            if m:
                out.append((m.group(1), email.message_from_bytes(part[1], policy=email.policy.default)))
    return sorted(out, key=lambda x: int(x[0]))


def report_date(msg: EmailMessage) -> str:
    """报告日期：取标题里的 YYYY-MM-DD，没有就用发送日期（本地时区）。"""
    m = re.search(r"\d{4}-\d{2}-\d{2}", str(msg["Subject"] or ""))
    return m.group(0) if m else f"{message_date(msg).astimezone():%Y-%m-%d}"


def archive(imap: imaplib.IMAP4_SSL, uids: list[bytes], all_mail_folder: str) -> None:
    """归档：把邮件从收件箱移到「所有邮件」（Gmail 里等于归档，不会删除），然后回查确认。

    注意：在收件箱里用 STORE -X-GM-LABELS (\\Inbox) 去标签，Gmail 回 OK 但实际不生效，所以用 MOVE。
    """
    if not uids:
        return
    uid_set = b",".join(uids)
    typ, data = imap.uid("MOVE", uid_set, f'"{all_mail_folder}"')
    if typ != "OK":
        die(f"归档失败：{data}")
    typ, data = imap.uid("SEARCH", "UID", uid_set)
    left = data[0].split() if typ == "OK" and data and data[0] else []
    if left:
        die(f"归档后仍有 {len(left)} 封留在收件箱（UID {b','.join(left).decode()}）")


def load_index() -> set[str]:
    seen = set()
    if INDEX_FILE.exists():
        for line in INDEX_FILE.read_text(encoding="utf-8").splitlines():
            if line.strip():
                seen.add(json.loads(line)["message_id"])
    return seen


def append_index(meta: dict) -> None:
    with INDEX_FILE.open("a", encoding="utf-8") as f:
        f.write(json.dumps({k: meta[k] for k in ("message_id", "dir", "date")}, ensure_ascii=False) + "\n")


def safe_name(name: str, fallback: str) -> str:
    name = os.path.basename(name or "").strip()
    name = re.sub(r"[^\w.\-一-鿿]+", "_", name).strip("._")
    return name[:120] or fallback


def message_date(msg: EmailMessage) -> datetime:
    try:
        dt = parsedate_to_datetime(str(msg["Date"]))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except (TypeError, ValueError):
        return datetime.now(timezone.utc)


def message_id_of(msg: EmailMessage, raw: bytes) -> str:
    mid = str(msg["Message-ID"] or "").strip()
    return mid or "sha256:" + hashlib.sha256(raw).hexdigest()


def save_message(raw: bytes) -> dict:
    """把一封原始邮件拆成 eml / 正文 / 附件 / meta 写到 data/raw/mail/ 下，返回 meta。"""
    msg = email.message_from_bytes(raw, policy=email.policy.default)
    mid = message_id_of(msg, raw)
    dt = message_date(msg).astimezone()
    short = hashlib.sha1(mid.encode()).hexdigest()[:8]
    out = RAW_DIR / f"{dt:%Y-%m-%d}_{short}"
    out.mkdir(parents=True, exist_ok=True)

    (out / "message.eml").write_bytes(raw)

    attachments = []
    for i, part in enumerate(msg.walk()):
        if part.is_multipart():
            continue
        filename = part.get_filename()
        ctype = part.get_content_type()
        if filename or part.get_content_disposition() == "attachment":
            name = safe_name(filename or "", f"part{i}")
            target = out / "attachments" / name
            target.parent.mkdir(exist_ok=True)
            target.write_bytes(part.get_payload(decode=True) or b"")
            attachments.append({"file": f"attachments/{name}", "content_type": ctype})
        elif ctype in ("text/plain", "text/html"):
            body_file = out / ("body.txt" if ctype == "text/plain" else "body.html")
            if not body_file.exists():
                body_file.write_text(part.get_content(), encoding="utf-8")

    meta = {
        "message_id": mid,
        "dir": out.name,
        "from": str(msg["From"] or ""),
        "subject": str(msg["Subject"] or ""),
        "date": dt.isoformat(),
        "attachments": attachments,
        "downloaded_at": datetime.now().astimezone().isoformat(timespec="seconds"),
    }
    (out / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    return meta


def cmd_list(imap: imaplib.IMAP4_SSL, limit: int) -> None:
    select(imap, "INBOX", readonly=True)
    typ, data = imap.uid("SEARCH", "ALL")
    uids = (data[0].split() if data and data[0] else [])[-limit:]
    print(f"收件箱最近 {len(uids)} 封（旧→新）：")
    for _, h in fetch_headers(imap, uids):
        print(f"  {message_date(h):%Y-%m-%d %H:%M}  {h['From']}  |  {h['Subject']}")
    print("\n找到报告邮件后，把发件人/标题写进 .env 的 MAIL_QUERY，例如：")
    print('  MAIL_QUERY=from:sender@example.com subject:问藏简报')


def download_new(imap: imaplib.IMAP4_SSL, uids: list[bytes], seen: set[str],
                 since: str | None, dry_run: bool) -> tuple[list[bytes], int]:
    """下载当前文件夹里未下载过的匹配邮件。返回（报告日期符合条件的 uid，新保存数）。"""
    kept, saved = [], 0
    for uid, h in fetch_headers(imap, uids):
        day = report_date(h)
        if since and day < since:
            continue
        kept.append(uid)
        mid = str(h["Message-ID"] or "").strip()
        label = f"{day}  {h['Subject']}"
        if mid and mid in seen:
            print(f"  已下载过  {label}")
            continue
        if dry_run:
            print(f"  [dry-run] 将下载  {label}")
            continue
        raw = fetch_raw(imap, uid)
        msg = email.message_from_bytes(raw, policy=email.policy.default)
        if message_id_of(msg, raw) in seen:
            continue
        meta = save_message(raw)
        append_index(meta)
        seen.add(meta["message_id"])
        saved += 1
        print(f"  已保存 data/raw/mail/{meta['dir']}  {label}")
    return kept, saved


def cmd_fetch(imap: imaplib.IMAP4_SSL, query: str, since: str | None, all_mail: bool,
              dry_run: bool, no_archive: bool) -> None:
    seen = load_index()
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    all_mail_folder = find_all_mail_folder(imap)

    # 收件箱：下载未下载过的；全部保存成功后再归档（已下载过的也归档，补上次中断的情况）
    select(imap, "INBOX", readonly=dry_run)
    kept, saved = download_new(imap, search(imap, query), seen, since, dry_run)
    print(f"收件箱匹配 {len(kept)} 封" + (f"（报告日期 ≥ {since}）" if since else ""))
    archived = 0
    if not dry_run and not no_archive and kept:
        archive(imap, kept, all_mail_folder)
        archived = len(kept)

    # 可选：补历史——在「所有邮件」里找未下载过的（不改动标签）
    if all_mail:
        select(imap, all_mail_folder, readonly=True)
        _, n = download_new(imap, search(imap, query), seen, since, dry_run)
        saved += n

    if not dry_run:
        print(f"完成：新保存 {saved} 封，归档 {archived} 封（已确认离开收件箱）。")


def main() -> None:
    p = argparse.ArgumentParser(description="下载 Gmail 每日访问报告邮件到 data/raw/mail/ 并归档")
    p.add_argument("--list", action="store_true", help="只列出收件箱最近的邮件，帮助写 MAIL_QUERY")
    p.add_argument("--limit", type=int, default=30, help="--list 显示多少封（默认 30）")
    p.add_argument("--dry-run", action="store_true", help="只显示会下载哪些，不下载不归档")
    p.add_argument("--no-archive", action="store_true", help="下载后不归档，留在收件箱")
    p.add_argument("--all-mail", action="store_true", help="也搜索已归档邮件，补下载历史")
    p.add_argument("--query", help="临时覆盖 .env 里的 MAIL_QUERY")
    p.add_argument("--since", metavar="YYYY-MM-DD",
                   help="只处理报告日期（标题里的日期）不早于此日的邮件；更早的不下载也不归档")
    args = p.parse_args()

    sys.stdout.reconfigure(line_buffering=True)
    load_env(ROOT / ".env")
    imap = connect()
    try:
        if args.list:
            cmd_list(imap, args.limit)
            return
        query = (args.query or os.environ.get("MAIL_QUERY", "")).strip()
        if not query:
            die("MAIL_QUERY 为空。先用 --list 找到报告邮件，再在 .env 里填 MAIL_QUERY，"
                "否则会把收件箱所有邮件都下载并归档。")
        if args.since and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", args.since):
            die("--since 格式应为 YYYY-MM-DD")
        cmd_fetch(imap, query, args.since, args.all_mail, args.dry_run, args.no_archive)
    finally:
        try:
            imap.logout()
        except Exception:
            pass


if __name__ == "__main__":
    main()
