#!/bin/bash
# serve.sh — local dev server, serves src/ on http://localhost:8080
cd src/
python3 -m http.server 8080
