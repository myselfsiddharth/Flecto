# Supported formats

| Format | Extensions |
|---|---|
| JSON / JSONC | `.json`, `.jsonc` |
| YAML | `.yaml`, `.yml` |
| TOML | `.toml` |
| INI | `.ini` |
| dotenv | `.env`, `.env.*`, `*.env` |
| age (armored) | `.age`, or any file whose contents are one armored blob |

`.json` accepts comments and trailing commas, so `tsconfig.json`,
`.vscode/settings.json`, `jsconfig.json`, and `devcontainer.json` are read as
written. →
**[JSON with comments](configuration.md#json-with-comments)**

Terraform plan JSON (`terraform show -json`) is read by **`flecto plan`**, which
applies Terraform's own sensitivity marking. Point `plan` at it rather than `ci`
or `watch` — those treat it as ordinary JSON and will print values Terraform
marks sensitive ([#113](https://github.com/myselfsiddharth/Flecto/issues/113)).

Multi-document YAML (`---`-separated, the usual shape of a Kubernetes manifest)
is supported. Each document is diffed under its own key — `kind/name` for
Kubernetes-shaped documents, so a document inserted at the top of the file does
not renumber every other path. →
**[Multi-document YAML](configuration.md#multi-document-yaml)**

---

---

## Encrypted files

SOPS- and age-encrypted files are detected from their **contents** and diffed
structurally — keys added and removed, which encrypted values moved, and who can
decrypt the file. **Flecto never decrypts.** →
**[Encrypted files](encrypted-files.md)**
