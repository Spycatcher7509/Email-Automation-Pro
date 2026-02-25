use axum::{
    extract::State,
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD as b64, Engine};
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    ChaCha20Poly1305, Key, Nonce,
};
use directories::ProjectDirs;
use once_cell::sync::OnceCell;
use pqcrypto_dilithium::dilithium5;
use pqcrypto_kyber::kyber1024;
use pqcrypto_traits::kem::{Ciphertext, PublicKey as KemPublicKey, SecretKey as KemSecretKey, SharedSecret};
use pqcrypto_traits::sign::{PublicKey as SigPublicKey, SecretKey as SigSecretKey, SignedMessage};
use rand_core::OsRng;
use serde::{Deserialize, Serialize};
use std::{fs, net::SocketAddr, path::PathBuf};
use tokio::net::TcpListener;
use thiserror::Error;
use tracing::{error, info};

#[derive(Clone)]
struct AppState {
    keys: Keys,
}

#[derive(Serialize, Deserialize, Clone)]
struct Keys {
    kem_public: String,
    kem_secret: String,
    sig_public: String,
    sig_secret: String,
}

#[derive(Serialize, Deserialize)]
struct EncryptRequest {
    plaintext: String,
    // Optional: recipient Kyber public key (base64). If absent, use local public key.
    recipient_kem_public: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct EncryptResponse {
    version: &'static str,
    kem: &'static str,
    aead: &'static str,
    recipient_kem_public: String,
    encapsulated_key: String,
    nonce: String,
    ciphertext: String,
    signature: String,
    signer_public: String,
}

#[derive(Deserialize)]
struct DecryptRequest {
    envelope: EncryptEnvelopeOwned,
    // optional override for secret key
    kem_secret: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
struct EncryptEnvelopeOwned {
    version: String,
    kem: String,
    aead: String,
    recipient_kem_public: String,
    encapsulated_key: String,
    nonce: String,
    ciphertext: String,
    signature: String,
    signer_public: String,
}

#[derive(Serialize)]
struct DecryptResponse {
    plaintext: String,
    signer_public: String,
    verified: bool,
    version: String,
}

#[derive(Error, Debug)]
enum AppError {
    #[error("invalid base64")]
    Base64(#[from] base64::DecodeError),
    #[error("encryption failure")]
    Encrypt,
    #[error("signing failure")]
    Sign,
    #[error("io")]
    Io(#[from] std::io::Error),
}

impl IntoResponse for AppError {
    fn into_response(self) -> axum::response::Response {
        error!("{:?}", self);
        (StatusCode::INTERNAL_SERVER_ERROR, self.to_string()).into_response()
    }
}

fn keys_path() -> anyhow::Result<PathBuf> {
    let proj = ProjectDirs::from("com", "emailautomation", "pqc-proxy")
        .ok_or_else(|| anyhow::anyhow!("no project dir"))?;
    let dir = proj.data_dir();
    fs::create_dir_all(dir)?;
    Ok(dir.join("keys.json"))
}

fn load_or_generate_keys() -> anyhow::Result<Keys> {
    static CACHE: OnceCell<Keys> = OnceCell::new();
    if let Some(k) = CACHE.get() {
        return Ok(k.clone());
    }
    let path = keys_path()?;
    if path.exists() {
        let data = fs::read_to_string(&path)?;
        let k: Keys = serde_json::from_str(&data)?;
        CACHE.set(k.clone()).ok();
        return Ok(k);
    }
    // Generate
    let (kem_public, kem_secret) = kyber1024::keypair();
    let (sig_public, sig_secret) = dilithium5::keypair();
    let keys = Keys {
        kem_public: b64.encode(kem_public.as_bytes()),
        kem_secret: b64.encode(kem_secret.as_bytes()),
        sig_public: b64.encode(sig_public.as_bytes()),
        sig_secret: b64.encode(sig_secret.as_bytes()),
    };
    fs::write(&path, serde_json::to_string_pretty(&keys)?)?;
    CACHE.set(keys.clone()).ok();
    Ok(keys)
}

fn kem_public_from_base64(s: &str) -> Result<kyber1024::PublicKey, AppError> {
    let bytes = b64.decode(s)?;
    Ok(kyber1024::PublicKey::from_bytes(&bytes).map_err(|_| AppError::Encrypt)?)
}

fn kem_secret_from_base64(s: &str) -> Result<kyber1024::SecretKey, AppError> {
    let bytes = b64.decode(s)?;
    Ok(kyber1024::SecretKey::from_bytes(&bytes).map_err(|_| AppError::Encrypt)?)
}

fn sign_secret_from_base64(s: &str) -> Result<dilithium5::SecretKey, AppError> {
    let bytes = b64.decode(s)?;
    Ok(dilithium5::SecretKey::from_bytes(&bytes).map_err(|_| AppError::Sign)?)
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt().with_env_filter("info").init();

    let keys = load_or_generate_keys()?;
    let state = AppState { keys };

    let app = Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/pubkeys", get(pubkeys))
        .route("/encrypt", post(encrypt))
        .route("/decrypt", post(decrypt))
        .with_state(state);

    let port: u16 = std::env::var("PQC_PROXY_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(8787);
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    info!("pqc-proxy listening on {}", addr);
    let listener = TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

async fn pubkeys(State(state): State<AppState>) -> impl IntoResponse {
    Json(serde_json::json!({
        "kem_public": state.keys.kem_public,
        "sig_public": state.keys.sig_public,
        "version": "pqc-proxy-kyber1024-dilithium5"
    }))
}

async fn encrypt(
    State(state): State<AppState>,
    Json(req): Json<EncryptRequest>,
) -> Result<Json<EncryptResponse>, AppError> {
    let recipient_pk_b64 = req
        .recipient_kem_public
        .as_deref()
        .unwrap_or(&state.keys.kem_public);
    let recipient_pk = kem_public_from_base64(recipient_pk_b64)?;
    let sender_sk = sign_secret_from_base64(&state.keys.sig_secret)?;

    // Kyber encapsulation
    let (ciphertext_kem, shared_secret) = kyber1024::encapsulate(&recipient_pk);

    // AEAD encrypt
    let mut key_bytes = [0u8; 32];
    let ss = shared_secret.as_bytes();
    key_bytes.copy_from_slice(&ss[..32]);
    let key = Key::from_slice(&key_bytes);
    let cipher = ChaCha20Poly1305::new(key);
    let nonce_bytes = rand_nonce();
    let nonce = Nonce::from_slice(&nonce_bytes); // 12 bytes
    let ct = cipher
        .encrypt(nonce, req.plaintext.as_bytes())
        .map_err(|_| AppError::Encrypt)?;

    // Sign ciphertext
    let signature = dilithium5::sign(&ct, &sender_sk);

    let resp = EncryptResponse {
        version: "pqc-hybrid-kyber1024-chacha-dilithium5",
        kem: "kyber1024",
        aead: "chacha20poly1305",
        recipient_kem_public: recipient_pk_b64.to_string(),
        encapsulated_key: b64.encode(ciphertext_kem.as_bytes()),
        nonce: b64.encode(nonce_bytes),
        ciphertext: b64.encode(&ct),
        signature: b64.encode(signature.as_bytes()),
        signer_public: state.keys.sig_public.clone(),
    };
    Ok(Json(resp))
}

async fn decrypt(
    State(state): State<AppState>,
    Json(req): Json<DecryptRequest>,
) -> Result<Json<DecryptResponse>, AppError> {
    let secret_b64 = req.kem_secret.as_deref().unwrap_or(&state.keys.kem_secret);
    let sk = kem_secret_from_base64(secret_b64)?;

    let ct_kem_bytes = b64.decode(req.envelope.encapsulated_key.as_str())?;
    let ct_kem = kyber1024::Ciphertext::from_bytes(&ct_kem_bytes)
        .map_err(|_| AppError::Encrypt)?;
    let shared = kyber1024::decapsulate(&ct_kem, &sk);

    let mut key_bytes = [0u8; 32];
    key_bytes.copy_from_slice(&shared.as_bytes()[..32]);
    let key = Key::from_slice(&key_bytes);
    let cipher = ChaCha20Poly1305::new(key);

    let nonce_bytes = b64.decode(req.envelope.nonce.as_str())?;
    if nonce_bytes.len() != 12 {
        return Err(AppError::Encrypt);
    }
    let mut nonce_arr = [0u8; 12];
    nonce_arr.copy_from_slice(&nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_arr);

    let ciphertext = b64.decode(req.envelope.ciphertext.as_str())?;
    let plaintext = cipher
        .decrypt(nonce, ciphertext.as_ref())
        .map_err(|_| AppError::Encrypt)?;

    // Verify signature (best-effort)
    let sig_bytes = b64.decode(req.envelope.signature.as_str())?;
    let sig = dilithium5::SignedMessage::from_bytes(&sig_bytes).map_err(|_| AppError::Sign)?;
    let sig_pub_bytes = b64.decode(req.envelope.signer_public.as_str())?;
    let sig_pub = dilithium5::PublicKey::from_bytes(&sig_pub_bytes).map_err(|_| AppError::Sign)?;
    let verified = dilithium5::open(&sig, &sig_pub).is_ok();

    Ok(Json(DecryptResponse {
        plaintext: String::from_utf8_lossy(&plaintext).to_string(),
        signer_public: req.envelope.signer_public.clone(),
        verified,
        version: req.envelope.version.to_string(),
    }))
}

fn rand_nonce() -> [u8; 12] {
    let mut n = [0u8; 12];
    use rand_core::RngCore;
    OsRng.fill_bytes(&mut n);
    n
}
