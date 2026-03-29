# {{project}}

Monorepo with multiple packages.

## Commands

```bash
npm install
npm run build --workspaces
npm test --workspaces
```

## Architecture

<!-- Fill in package layout and dependencies -->

## Conventions

- Each package in packages/ is independently versioned
- Shared types in packages/shared
- Use workspace references for inter-package deps
