import argparse
import csv
import json
import ipaddress
import re
from pathlib import Path


def redact_private_context(content):
    content = content.replace(str(Path.home()), "/Users/<user>")
    content = re.sub(r"mongodb(?:\+srv)?://[^\s`\"']+", "<redacted-mongodb-uri>", content)

    def redact_ip(match):
        try:
            address = ipaddress.ip_address(match.group())
        except ValueError:
            return match.group()
        return "<redacted-ip>" if address.is_global else match.group()

    return re.sub(r"\b(?:\d{1,3}\.){3}\d{1,3}\b", redact_ip, content)


def export(source, destination):
    rows = []
    for line in source.read_text(encoding="utf-8").splitlines():
        event = json.loads(line)
        if event.get("type") != "response_item":
            continue
        message = event.get("payload", {})
        if message.get("type") != "message" or message.get("role") not in {"user", "assistant"}:
            continue
        if message.get("channel") not in {None, "commentary", "final"}:
            continue
        content = "\n".join(
            block.get("text", "")
            for block in message.get("content", [])
            if block.get("type") in {"input_text", "output_text", "text"}
        ).strip()
        if not content or content.startswith(("<environment_context>", "<external_codex_apps_open_page>")):
            continue
        rows.append((event.get("timestamp", ""), message["role"], redact_private_context(content)))
    with destination.open("w", encoding="utf-8-sig", newline="") as output:
        writer = csv.writer(output)
        writer.writerow(("timestamp", "role", "content"))
        writer.writerows(rows)
    print(f"Exported {len(rows)} messages to {destination}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Export visible user/assistant messages from a Codex JSONL session.")
    parser.add_argument("session", type=Path)
    parser.add_argument("output", type=Path, nargs="?", default=Path("llm_logs.csv"))
    args = parser.parse_args()
    export(args.session, args.output)
