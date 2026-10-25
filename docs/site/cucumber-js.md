# Running with cucumber-js

`decisium run` already runs inside cucumber-js and loads your `cucumber.{js,mjs,cjs,json,yaml}`. Use raw
`npx cucumber-js` only when your project already runs cucumber that way (CI scripts, IDE run buttons) and you want
Decisium Steps in the same run as your own step definitions.

```js
// cucumber.mjs
export default {
  import: ["node_modules/decisium/dist/steps.js", "steps/**/*.js"],
  format: ["decisium/formatter"],
  worldParameters: { decisium: { record: "none" } },
};
```

```sh
npx cucumber-js features/checkout.feature
```

`import` takes file paths, not package names, hence the `node_modules/...` path. The options in
`worldParameters.decisium` are the same as `decisium run`'s flags; see [Configuration](configuration.md).
