import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const API_KEY = process.env.CANLII_API;
if (!API_KEY) {
  console.error("CANLII_API environment variable is required");
  process.exit(1);
}

const BASE_URL = "https://api.canlii.org/v1";

// ---------------------------------------------------------------------------
// Rate limiter — 2 req/s, 1 concurrent, 5 000/day
// ---------------------------------------------------------------------------

let dailyCount = 0;
let dailyResetDate = new Date().toDateString();
let lastRequestTime = 0;
let inFlight = false;
const queue: Array<{ resolve: (v: void) => void; reject: (e: Error) => void }> = [];

function resetDailyIfNeeded() {
  const today = new Date().toDateString();
  if (today !== dailyResetDate) {
    dailyCount = 0;
    dailyResetDate = today;
  }
}

async function acquireSlot(): Promise<void> {
  resetDailyIfNeeded();
  if (dailyCount >= 5000) {
    throw new Error("CanLII daily API limit (5 000 requests) reached");
  }
  if (inFlight) {
    await new Promise<void>((resolve, reject) => queue.push({ resolve, reject }));
  }
  inFlight = true;
  const now = Date.now();
  const wait = Math.max(0, 500 - (now - lastRequestTime));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestTime = Date.now();
  dailyCount++;
}

function releaseSlot() {
  inFlight = false;
  const next = queue.shift();
  if (next) next.resolve();
}

// ---------------------------------------------------------------------------
// CanLII HTTP helper
// ---------------------------------------------------------------------------

async function canliiRequest(
  path: string,
  params: Record<string, string> = {}
): Promise<unknown> {
  await acquireSlot();
  try {
    const url = new URL(`${BASE_URL}${path}`);
    url.searchParams.set("api_key", API_KEY!);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== "") url.searchParams.set(k, v);
    }
    const res = await fetch(url.toString());
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`CanLII API ${res.status}: ${body}`);
    }
    return await res.json();
  } finally {
    releaseSlot();
  }
}

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function err(message: string): ToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

// ---------------------------------------------------------------------------
// MCP Server factory
// ---------------------------------------------------------------------------

function createServer(): McpServer {
  const server = new McpServer({
    name: "canlii",
    version: "1.0.0",
  });

  // 1. List case databases
  server.registerTool(
    "list_case_databases",
    {
      title: "List Case Databases",
      description:
        "List all courts and tribunals in the CanLII collection with their database IDs.",
      inputSchema: {
        language: z
          .enum(["en", "fr"])
          .default("en")
          .describe("Response language"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ language }) => {
      try {
        return ok(await canliiRequest(`/caseBrowse/${language}/`));
      } catch (e) {
        return err(String(e));
      }
    }
  );

  // 2. List cases
  server.registerTool(
    "list_cases",
    {
      title: "List Cases",
      description:
        "List decisions from a specific caselaw database. Returns case titles, citations, and IDs.",
      inputSchema: {
        language: z
          .enum(["en", "fr"])
          .default("en")
          .describe("Response language"),
        databaseId: z
          .string()
          .describe(
            'Database ID from list_case_databases (e.g. "onca", "csc-scc")'
          ),
        offset: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe("Starting record index"),
        resultCount: z
          .number()
          .int()
          .min(1)
          .max(10000)
          .default(25)
          .describe("Number of results to return (max 10000)"),
        publishedBefore: z
          .string()
          .optional()
          .describe("Filter: published on CanLII before this date (YYYY-MM-DD)"),
        publishedAfter: z
          .string()
          .optional()
          .describe("Filter: published on CanLII after this date (YYYY-MM-DD)"),
        decisionDateBefore: z
          .string()
          .optional()
          .describe("Filter: decision date before (YYYY-MM-DD)"),
        decisionDateAfter: z
          .string()
          .optional()
          .describe("Filter: decision date after (YYYY-MM-DD)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({
      language,
      databaseId,
      offset,
      resultCount,
      publishedBefore,
      publishedAfter,
      decisionDateBefore,
      decisionDateAfter,
    }) => {
      try {
        const params: Record<string, string> = {
          offset: String(offset),
          resultCount: String(resultCount),
        };
        if (publishedBefore) params.publishedBefore = publishedBefore;
        if (publishedAfter) params.publishedAfter = publishedAfter;
        if (decisionDateBefore) params.decisionDateBefore = decisionDateBefore;
        if (decisionDateAfter) params.decisionDateAfter = decisionDateAfter;
        return ok(
          await canliiRequest(`/caseBrowse/${language}/${databaseId}/`, params)
        );
      } catch (e) {
        return err(String(e));
      }
    }
  );

  // 3. Get case metadata
  server.registerTool(
    "get_case",
    {
      title: "Get Case",
      description:
        "Get metadata for a specific case including title, citation, decision date, keywords, and URL.",
      inputSchema: {
        language: z
          .enum(["en", "fr"])
          .default("en")
          .describe("Response language"),
        databaseId: z.string().describe("Database ID (e.g. \"csc-scc\")"),
        caseId: z
          .string()
          .describe("Case ID from list_cases (e.g. \"2008scc9\")"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ language, databaseId, caseId }) => {
      try {
        return ok(
          await canliiRequest(
            `/caseBrowse/${language}/${databaseId}/${caseId}/`
          )
        );
      } catch (e) {
        return err(String(e));
      }
    }
  );

  // 4. Case citator
  server.registerTool(
    "get_case_citations",
    {
      title: "Get Case Citations",
      description:
        "Get citation information for a case: what it cites, what cites it, or what legislation it references. Note: only English is supported for this endpoint.",
      inputSchema: {
        databaseId: z.string().describe("Database ID (e.g. \"onca\")"),
        caseId: z
          .string()
          .describe("Case ID (e.g. \"1999canlii1527\")"),
        citationType: z
          .enum(["citedCases", "citingCases", "citedLegislations"])
          .describe(
            "Type of citation data to retrieve"
          ),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ databaseId, caseId, citationType }) => {
      try {
        return ok(
          await canliiRequest(
            `/caseCitator/en/${databaseId}/${caseId}/${citationType}`
          )
        );
      } catch (e) {
        return err(String(e));
      }
    }
  );

  // 5. List legislation databases
  server.registerTool(
    "list_legislation_databases",
    {
      title: "List Legislation Databases",
      description:
        "List all legislation and regulation databases in the CanLII collection.",
      inputSchema: {
        language: z
          .enum(["en", "fr"])
          .default("en")
          .describe("Response language"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ language }) => {
      try {
        return ok(await canliiRequest(`/legislationBrowse/${language}/`));
      } catch (e) {
        return err(String(e));
      }
    }
  );

  // 6. List legislation
  server.registerTool(
    "list_legislation",
    {
      title: "List Legislation",
      description:
        "List statutes or regulations from a specific legislation database.",
      inputSchema: {
        language: z
          .enum(["en", "fr"])
          .default("en")
          .describe("Response language"),
        databaseId: z
          .string()
          .describe(
            'Legislation database ID from list_legislation_databases (e.g. "ons" for Ontario statutes)'
          ),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ language, databaseId }) => {
      try {
        return ok(
          await canliiRequest(`/legislationBrowse/${language}/${databaseId}/`)
        );
      } catch (e) {
        return err(String(e));
      }
    }
  );

  // 7. Get legislation metadata
  server.registerTool(
    "get_legislation",
    {
      title: "Get Legislation",
      description:
        "Get metadata for a specific piece of legislation including title, citation, dates, and repeal status.",
      inputSchema: {
        language: z
          .enum(["en", "fr"])
          .default("en")
          .describe("Response language"),
        databaseId: z.string().describe("Legislation database ID"),
        legislationId: z
          .string()
          .describe(
            'Legislation ID from list_legislation (e.g. "rso-1990-c-a1")'
          ),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ language, databaseId, legislationId }) => {
      try {
        return ok(
          await canliiRequest(
            `/legislationBrowse/${language}/${databaseId}/${legislationId}/`
          )
        );
      } catch (e) {
        return err(String(e));
      }
    }
  );

  return server;
}

// ---------------------------------------------------------------------------
// Transport: stdio (default) or HTTP (--transport http)
// ---------------------------------------------------------------------------

const transportArg = process.argv.includes("--transport")
  ? process.argv[process.argv.indexOf("--transport") + 1]
  : "stdio";

async function main() {
  if (transportArg === "stdio") {
    const server = createServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("CanLII MCP server running on stdio");
  } else if (transportArg === "http") {
    const server = createServer();
    const transport = new WebStandardStreamableHTTPServerTransport();
    await server.connect(transport);

    type Env = { Variables: { parsedBody?: unknown } };
    const app = new Hono<Env>();

    // CORS for browser-based MCP clients
    app.use(
      "*",
      cors({
        origin: "*",
        allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
        allowHeaders: [
          "Content-Type",
          "mcp-session-id",
          "Last-Event-ID",
          "mcp-protocol-version",
        ],
        exposeHeaders: ["mcp-session-id", "mcp-protocol-version"],
      })
    );

    // JSON body pre-parsing (mirrors what @modelcontextprotocol/hono does)
    app.use("*", async (c, next) => {
      const ct = c.req.header("content-type") ?? "";
      if (ct.includes("application/json")) {
        try {
          const parsed = await c.req.raw.clone().json();
          c.set("parsedBody", parsed);
        } catch {
          return c.text("Invalid JSON", 400);
        }
      }
      return next();
    });

    app.all("/mcp", (c) =>
      transport.handleRequest(c.req.raw, {
        parsedBody: c.get("parsedBody"),
      })
    );

    const port = Number(process.env.PORT ?? 3000);
    serve({ fetch: app.fetch, port }, () => {
      console.error(`CanLII MCP server running on http://localhost:${port}/mcp`);
    });
  } else {
    console.error(`Unknown transport: ${transportArg}. Use "stdio" or "http".`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
