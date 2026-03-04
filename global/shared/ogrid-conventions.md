# WebProject1 Conventions

Shared knowledge for any project that consumes the WebProject1 library. Import this from your project's CLAUDE.md to avoid duplicating WebProject1 details.

## What WebProject1 is

WebProject1 is a multi-framework data grid library. A pure-TypeScript core (`@alaarab/web-project-1-core`) provides types, algorithms, and utilities with zero runtime dependencies. Framework packages wrap the core for React, Angular, Vue, and vanilla JS.

## Package naming

All packages follow `@alaarab/web-project-1-{target}`:

| Package | Use case |
|---------|----------|
| `@alaarab/web-project-1-core` | Types, algorithms, utilities (zero deps) |
| `@alaarab/web-project-1-react-fluent` | React + Fluent UI |
| `@alaarab/web-project-1-react-material` | React + Material UI |
| `@alaarab/web-project-1-react-radix` | React + Radix UI (lightweight default) |
| `@alaarab/web-project-1-angular-material` | Angular + Angular Material |
| `@alaarab/web-project-1-angular-primeng` | Angular + PrimeNG |
| `@alaarab/web-project-1-angular-radix` | Angular + Radix UI |
| `@alaarab/web-project-1-vue-vuetify` | Vue + Vuetify |
| `@alaarab/web-project-1-vue-primevue` | Vue + PrimeVue |
| `@alaarab/web-project-1-vue-radix` | Vue + Radix UI |
| `@alaarab/web-project-1-js` | Vanilla JS (no framework) |

Pick the package matching your framework + design system. You always get `@alaarab/web-project-1-core` as a transitive dependency.

## Key types (from `@alaarab/web-project-1-core`)

**`IColumnDef<T>`**: Defines a single column. Key fields: `field` (keyof T), `headerName`, `type` ('text' | 'numeric' | 'date' | 'boolean'), `filterable` (with filter type), `editable`, `renderCell`, `compare`.

**`IColumnMeta`**: Static column metadata (label, type, filterable config, responsivePriority). Used to separate column config from render logic.

**`IDataSource<T>`**: Server-side data provider. Has `fetchPage(params)`, `fetchFilterOptions(field)`, and optional `searchPeople(query)` / `getUserByEmail(email)` for people columns.

**`IFetchParams`**: What `fetchPage` receives: page, pageSize, sort (field + direction), filters (`IFilters`), search query.

**`IFilters`**: Record of field name to `FilterValue`. `FilterValue` is a discriminated union: text, multiSelect, people, or date.

**`UserLike`**: Shape for people/user data in people-type columns and filters.

## Consumer projects

| Project | Package | Role |
|---------|---------|------|
| WebProject2 | `@alaarab/web-project-1-react-fluent` | SPFx web part, server-side data, 100k+ rows |
| WebProject4 | `@alaarab/web-project-1-react-material` | Next.js app, migration target from ag-grid |

Both are integration test targets when making WebProject1 changes. WebProject2 tests the Fluent UI path, WebProject4 tests Material UI.

## Common consumer pattern

```typescript
const dataSource: IDataSource<MyRow> = {
  fetchPage: async (params: IFetchParams) => { /* server call */ },
  fetchFilterOptions: async (field) => { /* distinct values */ },
};
```

Columns are defined as `IColumnDef<MyRow>[]`, usually built from an `IColumnMeta[]` array that holds the static config.
