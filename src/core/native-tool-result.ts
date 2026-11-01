import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

/** Project only the final, middleware-filtered result. Never recover raw data after redaction. */
export function nativeToolResult(
  tool: { name?: string; outputSchema?: unknown },
  result: {content: AgentToolResult<unknown>["content"]; details?: unknown; structuredContent?: unknown; isError?: boolean},
  isError = result.isError === true,
): unknown {
  if (tool.outputSchema && result.structuredContent !== undefined) return result.structuredContent;
  const text = result.content.filter(part => part.type === "text").map(part => part.text).join("\n");
  if (isError) throw new Error(text || "Native tool call failed");
  // Older Pi read definitions expose images only in content, not structuredContent.
  // Select from the final content so middleware redaction remains authoritative.
  if (tool.name === "read") {
    const image = result.content.find(part => part.type === "image");
    if (image) return {...image, note: text};
  }
  // A detached shell call has no exit code yet. Keep its task id as a field so a
  // program can pass it to tasks.wait or tasks.get without parsing the notice.
  if (tool.name === "bash" || tool.name === "powershell") {
    const taskId = (result.details as {taskId?: unknown} | undefined)?.taskId;
    if (typeof taskId === "string") return {output: text, taskId};
  }
  return text;
}
