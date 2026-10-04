#!/usr/bin/env node
// A fake `gh` that connects and then never answers: the stalled-network case. It
// holds its stdout open and does nothing until it is killed.
setInterval(() => undefined, 1000);
