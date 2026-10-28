#!/bin/sh
# Fetch the VIDAA client certificate the TV demands for mutual TLS.
# The certificate is not redistributed here; it comes from the official app's
# key material, published for interoperability by the vidaa-remote project.
set -e
cd "$(dirname "$0")"
mkdir -p certs
curl -sSL -o certs/vidaa_client.pem https://raw.githubusercontent.com/adamazad/vidaa-remote/main/certs/vidaa_client.pem
curl -sSL -o certs/vidaa_client.key https://raw.githubusercontent.com/adamazad/vidaa-remote/main/certs/vidaa_client.key
chmod 600 certs/vidaa_client.key
openssl x509 -in certs/vidaa_client.pem -noout -subject -dates
echo "certificates ready in $(pwd)/certs"
