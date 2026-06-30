# Approach3 Configs

Keep reusable, non-secret configuration templates here.

Do not commit credentials, service-account keys, Earth Engine tokens, private asset inventories, or local `.env` files.

Recommended pattern for future configs:

```yaml
required:
  ee_project: "your-google-cloud-project-id"
  aoi_asset: "users/..."

optional:
  start_date: "2020-01-01"
  end_date: "2020-12-31"
  output_folder: "Approaches/Approach3/outputs/example_run"
```
