Okay, here is a concise version assuming you are running commands within the ./tls directory.

Prerequisites: openssl installed.

# Navigate to your TLS directory
cd ./tls # Or wherever your tls directory is relative to your current position


1. Create Root CA

# Generate Root CA Key (choose one)
openssl genpkey -algorithm RSA -out rootCA.key -aes256 -pkeyopt rsa_keygen_bits:2048 # With password (recommended)
# openssl genpkey -algorithm RSA -out rootCA.key -pkeyopt rsa_keygen_bits:2048      # Without password

# Generate Root CA Certificate (enter password if you set one)
openssl req -x509 -new -key rootCA.key -sha256 -days 1024 -out rootCA.crt \
    -subj "/C=US/ST=DevState/L=DevCity/O=Local Dev/CN=Local Dev Root CA"
IGNORE_WHEN_COPYING_START
content_copy
download
Use code with caution.
Bash
IGNORE_WHEN_COPYING_END

Output: rootCA.key, rootCA.crt

2. Create Server Certificate (with SAN for localhost/127.0.0.1)

# Create server.conf file (in ./tls directory) with this content:
cat > server.conf <<EOF
[ req ]
default_bits        = 2048
prompt              = no
default_md          = sha256
req_extensions      = req_ext
distinguished_name  = dn

[ dn ]
C=US
ST=DevState
L=DevCity
O=Local Dev WebApp
CN=localhost

[ req_ext ]
subjectAltName = @alt_names

[ alt_names ]
DNS.1 = localhost
IP.1 = 127.0.0.1
EOF

# Generate Server Key
openssl genpkey -algorithm RSA -out server.key -pkeyopt rsa_keygen_bits:2048

# Generate Server CSR (using server.conf for SANs)
openssl req -new -sha256 -key server.key -out server.csr -config server.conf

# Sign Server CSR with Root CA (enter Root CA password if set)
openssl x509 -req -in server.csr -CA rootCA.crt -CAkey rootCA.key \
    -CAcreateserial -out server.crt -days 365 -sha256 \
    -extfile server.conf -extensions req_ext
IGNORE_WHEN_COPYING_START
content_copy
download
Use code with caution.
Bash
IGNORE_WHEN_COPYING_END

Output: server.conf, server.key, server.csr (can remove), server.crt, rootCA.srl

3. Configure Web Server

Update your web server (Nginx, Apache, Django dev server, etc.) config to use:

SSL Certificate: ./tls/server.crt (full path might be needed)

SSL Key: ./tls/server.key (full path might be needed)

Restart your web server.

4. Trust Root CA System-Wide (Linux - Debian/Ubuntu/Mint)

sudo cp rootCA.crt /usr/local/share/ca-certificates/
sudo update-ca-certificates
IGNORE_WHEN_COPYING_START
content_copy
download
Use code with caution.
Bash
IGNORE_WHEN_COPYING_END

(Command varies for other distros)

5. Trust Root CA in Firefox

Firefox Settings -> Privacy & Security -> Certificates -> View Certificates...

Go to Authorities tab -> Import...

Select ./tls/rootCA.crt.

Check ✅ Trust this CA to identify websites.

Click OK -> OK.

Restart Firefox.

6. Verify

Access https://localhost:PORT or https://127.0.0.1:PORT (replace PORT with your server's port).

You should see the padlock icon 🔒 with no warnings.
