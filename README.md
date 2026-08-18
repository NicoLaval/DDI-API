# DDI API

REST API for DDI (Data Documentation Initiative), an international standard for describing statistical and social science data.

### Get involved

- **[Follow the roadmap](https://github.com/orgs/Making-Sense-Info/projects/6)**
- **[Issues](https://github.com/Making-Sense-Info/DDI-API/issues)** — Report bugs or give feedback (feature requests, API improvements).
- **[Discussions](https://github.com/Making-Sense-Info/DDI-API/discussions)** — Share use cases, ask questions, and discuss with the DDI community.

## Description

This API provides access to DDI metadata resources.

**Recommended entry points:** **`GET /ddi/v1/items`** (full `ItemCatalog`) and **`GET /ddi/v1/items/{itemIdentifier}`** (one object, polymorphic — URN, `agency:id:version` in the path, or plain id + `agencyID` / `version` query). Query parameters for the list are the **same union as on the per-type list endpoints**. Prefer **`/variables`**, **`/concepts`**, etc. when you already know the type.

For detailed API usage, endpoints, and examples, see the [Mock API Endpoints Documentation](docs/MOCK_API_ENDPOINTS.md).

### Resource identifiers

Identifiers follow an **URN-first** rule (see `ddi-rest.yaml`):

- **DDI URN** (`urn:ddi:{agency}:{id}:{version}`): identifies a resource unambiguously; no extra query parameters are required.
- **Plain ID**: meaningful only within a DDI agency; **`agencyID`** and **`version`** query parameters are **required** on the same request (path or list filters).
- There is **no** global lookup by plain ID alone across agencies or versions.

If a plain ID is used without both `agencyID` and `version`, the API responds with **`400 Bad Request`**.

Examples in the [mock endpoints guide](docs/MOCK_API_ENDPOINTS.md) use `agencyID=example.agency` and `version=1.0.0` for plain identifiers.

### Pagination

**List** endpoints (`GET /ddi/v1/variables`, `GET /ddi/v1/concepts`, `GET /ddi/v1/search/labels`, …) are always paginated: `limit` defaults to **100** (max **1000**), `offset` defaults to **0**. The DDI payload is unchanged; page metadata is in **`Content-Range`** and **`Link`**. Invalid values return **`400`**.

**`GET /ddi/v1/items`** and single-item GETs are **not** paginated. Details: [Mock API Endpoints](docs/MOCK_API_ENDPOINTS.md#pagination-list-endpoints).

## OpenAPI Specification

The API specification is available in the `ddi-rest.yaml` file in OpenAPI 3.1.1 format.

## Documentation & Links

### Online Documentation

- **Swagger UI**: [View on GitHub Pages](https://making-sense-info.github.io/DDI-API/)

### Local Development

To view and test the API specification locally:

- **Swagger Editor**: Open [https://editor.swagger.io/](https://editor.swagger.io/) and paste the contents of `ddi-rest.yaml` or load it directly from the repository
- **Local Swagger UI**: Run `yarn build:swagger` and `yarn preview:swagger` to start a local Swagger UI server
- **Local Mock Server**: Run `yarn mock` to start a mock API server for testing

### Accept Header

The API supports DDI-specific response formats only. Use the `Accept` header to specify your preferred format:

**DDI JSON Format (default):**
```bash
# DDI JSON format (default - no Accept header needed)
curl https://api.example.com/ddi/v1/variables

# Explicit DDI JSON request
curl -H "Accept: application/vnd.ddi.structure+json;version=3.3" https://api.example.com/ddi/v1/variables
```

**DDI XML Format:**
```bash
# DDI XML format (requires Accept header)
curl -H "Accept: application/vnd.ddi.structure+xml;version=3.3" https://api.example.com/ddi/v1/variables
```

**Supported Content Types:**
- `application/vnd.ddi.structure+json;version=3.3` - DDI JSON format (default if no Accept header)
- `application/vnd.ddi.structure+xml;version=3.3` - DDI XML format

**Note:** 
- If no `Accept` header is provided, the API returns DDI JSON format by default.
- Generic formats (`application/json`, `application/xml`, `text/xml`) are not supported and will return a `406 Not Acceptable` error.
