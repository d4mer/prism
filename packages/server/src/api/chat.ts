import express, { type Router } from "express";
import { convertToModelMessages, type UIMessage } from "ai";
import { streamChat, type KnowledgeBase } from "@prism/core";

interface ChatBody {
  messages: UIMessage[];
  model?: string;
}

/**
 * Streaming chat endpoint for the web UI (`useChat`). Full agent toolset —
 * the chat exists to exercise the same agent the MCP server uses.
 */
export function chatRouter(kb: KnowledgeBase): Router {
  const router = express.Router();

  router.post("/chat", async (req, res) => {
    const { messages, model } = req.body as ChatBody;
    // Absence of a provider is reported as a clean JSON error, not an
    // unhandled rejection — the chat UI reads this via useChat's onError.
    let result: Awaited<ReturnType<typeof streamChat>>["result"];
    try {
      ({ result } = await streamChat(kb, convertToModelMessages(messages), { model }));
    } catch (err) {
      res.status(503).json({
        error: (err as Error).message,
        hint: "Set LLM_API_BASE_URL + LLM_API_KEY + LLM_API_FORMAT + LLM_MODEL to enable chat.",
      });
      return;
    }
    const response = result.toUIMessageStreamResponse();
    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));
    if (response.body) {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        res.write(chunk);
      }
    }
    res.end();
  });

  return router;
}
