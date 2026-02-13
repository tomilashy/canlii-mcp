# canlii-mcp

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server for the [CanLII](https://www.canlii.org) Canadian legal information API. Gives AI assistants access to Canadian case law and legislation metadata across all federal, provincial, and territorial jurisdictions.

> **Note:** The CanLII API provides metadata only — titles, citations, dates, keywords, and citation relationships. Full document text is not available through the API.

## Tools

| Tool | Description |
|------|-------------|
| `list_case_databases` | List all courts and tribunals in the CanLII collection |
| `list_cases` | Browse decisions from a specific court/tribunal database |
| `get_case` | Get metadata for a specific case (title, citation, date, keywords) |
| `get_case_citations` | Get cases cited by a case, cases citing it, or legislation it references |
| `list_legislation_databases` | List all statute and regulation databases |
| `list_legislation` | Browse statutes or regulations from a specific database |
| `get_legislation` | Get metadata for a specific piece of legislation |

## Requirements

- Node.js 22+
- A CanLII API key — [apply here](https://www.canlii.org/en/feedback/feedback.html)

## Usage

### stdio (Claude Desktop / Claude Code)

```bash
npm install
npm run build
node dist/index.js
```

Add to your MCP config:

```json
{
  "mcpServers": {
    "canlii": {
      "command": "node",
      "args": ["/path/to/canlii-mcp/dist/index.js"],
      "env": {
        "CANLII_API": "your_api_key"
      }
    }
  }
}
```

### HTTP server

```bash
PORT=3000 CANLII_API=your_api_key node dist/index.js --transport http
```

The MCP endpoint is available at `http://localhost:3000/mcp`.

### Docker

```bash
docker run -e CANLII_API=your_api_key -p 3000:3000 ghcr.io/tomilashy/canlii-mcp
```

Or with Docker Compose:

```yaml
services:
  canlii-mcp:
    image: ghcr.io/tomilashy/canlii-mcp
    environment:
      CANLII_API: your_api_key
    ports:
      - "3000:3000"
```

## Configuration

| Environment Variable | Required | Default | Description |
|---------------------|----------|---------|-------------|
| `CANLII_API` | Yes | — | Your CanLII API key |
| `PORT` | No | `3000` | HTTP server port (HTTP mode only) |

## Rate Limits

The server enforces CanLII's API limits automatically:

- 1 request at a time
- 2 requests per second
- 5,000 requests per day

Requests that exceed the daily limit return an error rather than hitting the API.

## Development

```bash
npm install
npm run build      # compile TypeScript
npm run watch      # watch mode
```

## Release

This project uses [Semantic Versioning](https://semver.org) via [semantic-release](https://semantic-release.gitbook.io). Commit messages follow the [Conventional Commits](https://www.conventionalcommits.org) spec:

| Commit prefix | Release type |
|---------------|-------------|
| `fix:` | Patch (`1.0.0` → `1.0.1`) |
| `feat:` | Minor (`1.0.0` → `1.1.0`) |
| `feat!:` or `BREAKING CHANGE` | Major (`1.0.0` → `2.0.0`) |

Pushing to `main` triggers the release workflow. If a release is cut, the Docker image is automatically built and published to `ghcr.io`.

## License

MIT
