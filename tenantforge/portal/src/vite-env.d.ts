/// <reference types="vite/client" />

// The portal SPA holds no OIDC config: the login mode + IdP authorize URL come from the server
// (`GET /portal/api/config` + `GET /portal/api/login/start`), so the browser bundle ships no
// client id / endpoints and never generates PKCE secrets (H1/H2). No VITE_* env is read here.
