# DDI API

REST API for [DDI](https://ddialliance.org/) (Data Documentation Initiative) metadata: study units, datasets, variables, concepts, schemes, and related resources.

### [Swagger UI](https://making-sense-info.github.io/DDI-API/)

Interactive OpenAPI 3.1 documentation — browse every endpoint and try requests against the live mock.

The mock server is at **[ddi-api.making-sense.info](https://ddi-api.making-sense.info)** (base path `/ddi/v1`). The contract itself lives in [`ddi-rest.yaml`](ddi-rest.yaml).

## Quick start

```bash
# Catalog of all mock items
curl https://ddi-api.making-sense.info/ddi/v1/items

# Variables (DDI JSON is the default)
curl https://ddi-api.making-sense.info/ddi/v1/variables

# Same list as DDI XML
curl -H "Accept: application/vnd.ddi.structure+xml;version=3.3" \
  https://ddi-api.making-sense.info/ddi/v1/variables
```

More examples, filters, and identifier rules: [Mock API endpoints](docs/MOCK_API_ENDPOINTS.md).

## Using the API

- **Entry points:** `GET /items` (full `ItemCatalog`) and `GET /items/{itemIdentifier}` (one object, any type). Use `/variables`, `/concepts`, etc. when you already know the type.
- **Identifiers:** a DDI URN (`urn:ddi:{agency}:{id}:{version}`) is enough. A plain ID needs `agencyID` and `version` on the same request (`400` otherwise).
- **Lists** are always paginated (`limit` default 100, max 1000; `offset` default 0). Page metadata is in `Content-Range` and `Link`, not in the DDI body. `GET /items` and single-item GETs are not paginated.
- **Media types:** `application/vnd.ddi.structure+json;version=3.3` (default) and `application/vnd.ddi.structure+xml;version=3.3`. Generic `application/json` or `application/xml` return `406`.

Full rules are in the [Swagger UI](https://making-sense-info.github.io/DDI-API/) description and in `ddi-rest.yaml`.

## Local development

```bash
yarn mock              # mock server → http://localhost:4010
yarn build:swagger && yarn preview:swagger   # local Swagger UI → http://localhost:8080
```

You can also paste `ddi-rest.yaml` into [Swagger Editor](https://editor.swagger.io/). Node **24+** is required (`engines.node`).

## Get involved

- [Roadmap](https://github.com/orgs/Making-Sense-Info/projects/6)
- [Issues](https://github.com/Making-Sense-Info/DDI-API/issues)
- [Discussions](https://github.com/Making-Sense-Info/DDI-API/discussions)
