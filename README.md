# Portcullis register

Registers the flags declared in a `portcullis.json` file with a Portcullis environment, and archives the flags this source no longer declares.

```yaml
permissions:
  id-token: write
steps:
  - uses: actions/checkout@v5
  - uses: Evanion/portcullis-register@v1
    with:
      realm: my-realm
      project: my-project
      env: production
      source: my-service
```

The job authenticates with GitHub OIDC. Link the repository to the realm first in the Portcullis console (Settings, GitHub). Outside GitHub Actions, set `PORTCULLIS_TOKEN` instead.

This repository holds the built action only. Its source lives in the Portcullis monorepo and every release here is generated from it.
