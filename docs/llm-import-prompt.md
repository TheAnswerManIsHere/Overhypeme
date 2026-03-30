# LLM Bulk Import Prompt — Chuck Norris Facts

Copy-paste the prompt below into Claude (or any capable LLM) to scrape a webpage and
produce a JSON payload that can be submitted directly to the bulk-import API.

---

## Prompt template

```
You are a data-extraction assistant. Your task is to read the webpage at the URL below,
extract all distinct Chuck Norris facts / memes / jokes, and format them as a JSON array
that can be POSTed to an import API.

URL to scrape: <PASTE TARGET URL HERE>

Rules for extraction:
1. Include every distinct fact/joke you find. If the same fact appears more than once,
   include it only once.
2. Skip anything that is not a Chuck Norris fact (e.g. navigation text, ads, author bios).
3. For each fact, suggest up to 5 relevant hashtags from this list, or invent short
   lowercase ones if nothing fits:
   strength, fear, law, animals, math, space, time, computers, sports, cooking,
   history, science, weather, logic, impossible
4. Hashtags must match the regex ^[a-zA-Z0-9_]+$ (letters, numbers, underscores only)
   and be at most 100 characters.

Output format — a raw JSON array (no markdown fences, no explanations, just the JSON):

[
  {
    "text": "<full fact text, 10–1000 characters>",
    "hashtags": ["<tag1>", "<tag2>"]
  }
]

Do not include any text outside the JSON array.
```

---

## Submitting to the API

Once you have the JSON array from the LLM, submit it with `curl`:

```bash
BASE_URL="https://<YOUR_REPLIT_DOMAIN>/api"
API_KEY="<YOUR_ADMIN_API_KEY>"

# Dry-run first — validates all items without writing anything
curl -s -X POST "$BASE_URL/admin/import/facts?dryRun=true" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $API_KEY" \
  -d @facts.json | jq .

# If the dry-run looks good, remove ?dryRun=true to actually import
curl -s -X POST "$BASE_URL/admin/import/facts" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $API_KEY" \
  -d @facts.json | jq .
```

Replace `<YOUR_REPLIT_DOMAIN>` with your deployed domain (e.g. `my-app.replit.app`)
and `<YOUR_ADMIN_API_KEY>` with the value of the `ADMIN_API_KEY` environment secret.

---

## Response shape

```jsonc
// Normal import
{
  "created": 42,    // facts successfully inserted
  "skipped": 3,     // valid facts that were exact-text duplicates
  "failed": [       // items that failed schema validation
    {
      "index": 7,   // zero-based position in the submitted array
      "errors": [
        { "field": "text", "message": "text must be at least 10 characters" }
      ]
    }
  ]
}

// Dry-run (no writes)
{
  "dryRun": true,
  "wouldCreate": 42,
  "failed": []
}
```

---

## Schema reference

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `text` | string | yes | 10–1000 characters |
| `hashtags` | string[] | no | max 20 items; each max 100 chars; `^[a-zA-Z0-9_]+$` |

Maximum 500 facts per request.
