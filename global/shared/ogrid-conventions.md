# OGrid Conventions

Shared knowledge for any project that consumes the OGrid library. Import this from your project's CLAUDE.md to avoid duplicating OGrid details.

## What OGrid is

OGrid is a multi-framework data grid library. A pure-TypeScript core (`@alaarab/ogrid-core`) provides types, algorithms, and utilities with zero runtime dependencies. Framework packages wrap the core for React, Angular, Vue, and vanilla JS.

## Package naming

All packages follow `@alaarab/ogrid-{target}`:

| Package | Use case |
|---------|----------|
| `@alaarab/ogrid-core` | Types, algorithms, utilities (zero deps) |
| `@alaarab/ogrid-react-fluent` | React + Fluent UI |
| `@alaarab/ogrid-react-material` | React + Material UI |
| `@alaarab/ogrid-react-radix` | React + Radix UI (lightweight default) |
| `@alaarab/ogrid-angular-material` | Angular + Angular Material |
| `@alaarab/ogrid-angular-primeng` | Angular + PrimeNG |
| `@alaarab/ogrid-angular-radix` | Angular + Radix UI |
| `@alaarab/ogrid-vue-vuetify` | Vue + Vuetify |
| `@alaarab/ogrid-vue-primevue` | Vue + PrimeVue |
| `@alaarab/ogrid-vue-radix` | Vue + Radix UI |
| `@alaarab/ogrid-js` | Vanilla JS (no framework) |

Pick the package matching your framework + design system. You always get `@alaarab/ogrid-core` as a transitive dependency.

## Key types (from `@alaarab/ogrid-core`)

**`IColumnDef<T>`**: Defines a single column. Key fields: `field` (keyof T), `headerName`, `type` ('text' | 'numeric' | 'date' | 'boolean'), `filterable` (with filter type), `editable`, `renderCell`, `compare`.

**`IColumnMeta`**: Static column metadata (label, type, filterable config, responsivePriority). Used to separate column config from render logic.

**`IDataSource<T>`**: Server-side data provider. Has `fetchPage(params)`, `fetchFilterOptions(field)`, and optional `searchPeople(query)` / `getUserByEmail(email)` for people columns.

**`IFetchParams`**: What `fetchPage` receives: page, pageSize, sort (field + direction), filters (`IFilters`), search query.

**`IFilters`**: Record of field name to `FilterValue`. `FilterValue` is a discriminated union: text, multiSelect, people, or date.

**`UserLike`**: Shape for people/user data in people-type columns and filters.

## Consumer projects

| Project | Package | Role |
|---------|---------|------|
| ProjectCenter | `@alaarab/ogrid-react-fluent` | SPFx web part, server-side data, 100k+ rows |
| EMV | `@alaarab/ogrid-react-material` | Next.js app, migration target from ag-grid |

Both are integration test targets when making OGrid changes. ProjectCenter tests the Fluent UI path, EMV tests Material UI.

## Common consumer pattern

```typescript
const dataSource: IDataSource<MyRow> = {
  fetchPage: async (params: IFetchParams) => { /* server call */ },
  fetchFilterOptions: async (field) => { /* distinct values */ },
};
```

Columns are defined as `IColumnDef<MyRow>[]`, usually built from an `IColumnMeta[]` array that holds the static config.
