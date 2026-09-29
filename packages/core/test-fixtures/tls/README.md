# TLS fixtures

A local CA and a server certificate it signed. Tests use them to show that
`tls.ca` in `project.yml` makes such a server trusted (SPEC.md §1.1). They are
for tests only: the server's private key is committed on purpose, and nothing
outside these tests should ever trust `ca.pem`.

| File             | What                                                                 |
| ---------------- | -------------------------------------------------------------------- |
| `ca.pem`         | `CN=Gravity Test CA`, `CA:TRUE`, EC P-256, valid until 2126          |
| `server.pem`     | `CN=localhost`, signed by `ca.pem`, for `localhost` and `127.0.0.1`  |
| `server-key.pem` | `server.pem`'s private key                                           |

The CA's own key was thrown away. To make a new set, with a new CA:

```sh
cat > ca.cnf <<'EOF'
[req]
distinguished_name = dn
prompt = no
x509_extensions = v3_ca
[dn]
CN = Gravity Test CA
O = Gravity Test Automation
[v3_ca]
basicConstraints = critical, CA:TRUE
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
EOF
cat > server.cnf <<'EOF'
[req]
distinguished_name = dn
prompt = no
[dn]
CN = localhost
O = Gravity Test Automation
[v3_server]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature
extendedKeyUsage = serverAuth
subjectAltName = DNS:localhost, IP:127.0.0.1
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
EOF
openssl ecparam -name prime256v1 -genkey -noout -out ca-key.pem
openssl req -new -x509 -key ca-key.pem -sha256 -days 36500 -config ca.cnf -out ca.pem
openssl ecparam -name prime256v1 -genkey -noout -out server-key.pem
openssl req -new -key server-key.pem -config server.cnf -out server.csr
openssl x509 -req -in server.csr -CA ca.pem -CAkey ca-key.pem -CAcreateserial -sha256 \
  -days 36500 -extfile server.cnf -extensions v3_server -out server.pem
rm ca-key.pem ca.srl server.csr ca.cnf server.cnf
```
