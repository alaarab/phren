// React 19's automatic JSX transform, backed by our local shared runtime.
// Script mode preserves the globals shared by the motion lab's JSX files.
Babel.registerPreset("phren-react", {
  sourceType: "script",
  // Keep Babel standalone's original env preset: the separate lab scripts
  // redeclare hook bindings and rely on its conversion of const to var.
  presets: [Babel.availablePresets.env, [Babel.availablePresets.react, { runtime: "automatic" }]],
  plugins: [function ({ types: t }) {
    return {
      visitor: {
        CallExpression(path) {
          const { node } = path;
          if (t.isIdentifier(node.callee, { name: "require" }) &&
              node.arguments.length === 1 &&
              t.isStringLiteral(node.arguments[0], { value: "react/jsx-runtime" })) {
            path.replaceWith(t.memberExpression(t.identifier("window"), t.identifier("ReactJSXRuntime")));
          }
        },
      },
    };
  }],
});
