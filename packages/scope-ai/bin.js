#!/usr/bin/env node
// `npm install -g scope-ai` installs the `scope` command from @scope-ai/cli.
import { main } from '@scope-ai/cli';

process.exitCode = await main(process.argv.slice(2));
