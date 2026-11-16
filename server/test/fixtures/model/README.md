These bodies are hand-written to the installed OpenAI SDK types (`openai@7.57`), because the build machine has no OpenAI access. They are not recordings.

`npm run record:model` overwrites them with real response bodies. The replay tests in `test/model-adapters.test.ts` run against whichever version is on disk.
