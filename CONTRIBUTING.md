# Contributing

Node.js 22.6 or later is required.

```sh
git clone https://github.com/sprintsynergyhq/qa-core-flaky.git
cd qa-core-flaky
npm ci
npm run typecheck
npm test
```

`npm test` builds `dist/` and runs the unit tests. Those tests do not install browsers and they do not call the network.

Bug reports and pull requests are welcome. The license is MIT.
