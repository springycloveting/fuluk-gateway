import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_SESSIONS_DIR = "/home/v6/work/CodeClip/data/sessions";
const MAX_AGENT_RESULT_LENGTH = 500;
const RECORDABLE_HISTORY_LIMIT = 50;

export class CodeClipSessionRecorder {
  constructor(options = {}) {
    this.sessionsDir = options.sessionsDir ?? DEFAULT_SESSIONS_DIR;
    this.now = options.now ?? (() => new Date());
  }

  async recordBeforeInput(session, inputText, { store, tmux }) {
    if (!isRecordableUserMessage(inputText)) return null;
    if (typeof store?.listInputHistory !== "function" || typeof tmux?.capture !== "function") return null;

    const userMessage = latestRecordableUserMessage(store.listInputHistory(session.id, RECORDABLE_HISTORY_LIMIT));
    if (!userMessage) return null;

    const output = await tmux.capture(session, 200);
    const agentResult = extractFinalAnswer(output);
    if (!agentResult) return null;

    const timestamp = this.now();
    const record = {
      session_id: session.id,
      project: session.project || session.name,
      date: datePart(timestamp),
      turns: [
        {
          timestamp: timestamp.toISOString(),
          user_message: userMessage.text,
          agent_result: agentResult
        }
      ]
    };

    await this.append(record);
    return record;
  }

  async append(record) {
    await fs.mkdir(this.sessionsDir, { recursive: true });
    const filePath = path.join(this.sessionsDir, `${record.date}.jsonl`);
    await fs.appendFile(filePath, `${JSON.stringify(record)}\n`, "utf8");
  }
}

export function isRecordableUserMessage(text) {
  if (typeof text !== "string") return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  return !/^(?:[1-4]|yes|no|allow|a)$/iu.test(trimmed);
}

export function latestRecordableUserMessage(history) {
  if (!Array.isArray(history)) return null;
  return history.find((item) => isRecordableUserMessage(item?.text)) ?? null;
}

export function extractFinalAnswer(output) {
  const text = stripAnsi(String(output ?? "")).replace(/\r/g, "");
  const jsonAnswer = extractLastJsonFinalAnswer(text);
  if (jsonAnswer) return truncateResult(jsonAnswer);

  const labelAnswer = extractLastLabeledFinalAnswer(text);
  if (labelAnswer) return truncateResult(labelAnswer);

  const paragraph = lastUsefulParagraph(text);
  return paragraph ? truncateResult(paragraph) : "";
}

function extractLastJsonFinalAnswer(text) {
  const matches = [...text.matchAll(/"final_answer"\s*:\s*"((?:\\.|[^"\\])*)"/gu)];
  const last = matches.at(-1)?.[1];
  if (!last) return "";
  try {
    return JSON.parse(`"${last}"`).trim();
  } catch {
    return last.trim();
  }
}

function extractLastLabeledFinalAnswer(text) {
  const lines = text.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = lines[index].match(/(?:final_answer|final answer|最终答复|最终回复)\s*[:：]\s*(.+)$/iu);
    if (match?.[1]?.trim()) return match[1].trim();
  }
  return "";
}

function lastUsefulParagraph(text) {
  const paragraphs = text
    .split(/\n\s*\n/u)
    .map((paragraph) => cleanParagraph(paragraph))
    .filter(Boolean);
  for (let index = paragraphs.length - 1; index >= 0; index -= 1) {
    const paragraph = paragraphs[index];
    if (!isTerminalControlParagraph(paragraph)) return paragraph;
  }
  return "";
}

function cleanParagraph(paragraph) {
  return paragraph
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !isTerminalChromeLine(line))
    .join("\n")
    .trim();
}

function isTerminalChromeLine(line) {
  return (
    /^[\s┃│║╎╏╹╺╻╸━─▀▄█▁▔┄┈┉╭╮╰╯┌┐└┘├┤┬┴┼]+$/u.test(line) ||
    /^[┃│║]\s*Build\s*·.*\bEngine\b/iu.test(line) ||
    /^\d+(?:\.\d+)?[KMG]?\s+\(\d+%\)\s+ctrl\+p commands\b/iu.test(line) ||
    /\bctrl\+p commands\b/iu.test(line) ||
    /^(?:›|>|❯)\s*$/u.test(line) ||
    /^ctrl[+-]/iu.test(line) ||
    /^esc\b/iu.test(line) ||
    /^enter\b/iu.test(line)
  );
}

function isTerminalControlParagraph(paragraph) {
  const compact = paragraph.replace(/\s+/gu, " ").trim();
  return !compact || !isRecordableUserMessage(compact) || /^╭|^╰/u.test(compact);
}

function truncateResult(text) {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_AGENT_RESULT_LENGTH) return trimmed;
  return `${trimmed.slice(0, MAX_AGENT_RESULT_LENGTH - 1)}…`;
}

function stripAnsi(text) {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function datePart(date) {
  return date.toISOString().slice(0, 10);
}
