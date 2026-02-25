use base64::{engine::general_purpose::STANDARD as b64, Engine};
use chacha20poly1305::{aead::Aead, KeyInit, ChaCha20Poly1305, Key, Nonce};
use pqcrypto_dilithium::dilithium5;
use pqcrypto_kyber::kyber1024;
use pqcrypto_traits::kem::{SecretKey as KemSecretKey, Ciphertext as KemCiphertext, SharedSecret};
use pqcrypto_traits::sign::PublicKey as SigPublicKey;
use pqcrypto_traits::sign::SignedMessage;
use serde::Deserialize;
use std::{fs, path::PathBuf};
use structopt::StructOpt;

#[derive(StructOpt)]
struct Args {
    /// Path to envelope JSON
    #[structopt(parse(from_os_str))]
    envelope: PathBuf,
    /// Path to secret key JSON (keys.json from pqc-proxy)
    #[structopt(parse(from_os_str))]
    keys: PathBuf,
}

#[derive(Deserialize)]
struct Keys {
    kem_secret: String,
    sig_public: String,
}

#[derive(Deserialize)]
struct Envelope {
    version: String,
    kem: String,
    aead: String,
    encapsulated_key: String,
    nonce: String,
    ciphertext: String,
    signature: String,
    signer_public: String,
}

fn main() -> anyhow::Result<()> {
    let args = Args::from_args();
    let env_json = fs::read_to_string(args.envelope)?;
    let env: Envelope = serde_json::from_str(&env_json)?;
    let keys: Keys = serde_json::from_str(&fs::read_to_string(args.keys)?)?;

    let sk_bytes = b64.decode(keys.kem_secret.trim())?;
    let sk = kyber1024::SecretKey::from_bytes(&sk_bytes)?;

    let ct_kem = kyber1024::Ciphertext::from_bytes(&b64.decode(env.encapsulated_key.trim())?)?;
    let shared = kyber1024::decapsulate(&ct_kem, &sk);

    let mut key_bytes = [0u8; 32];
    key_bytes.copy_from_slice(&shared.as_bytes()[..32]);
    let key = Key::from_slice(&key_bytes);
    let cipher = ChaCha20Poly1305::new(key);
    let nonce_vec = b64.decode(env.nonce.trim())?;
    if nonce_vec.len() != 12 {
        anyhow::bail!("nonce must be 12 bytes");
    }
    let mut nonce_bytes = [0u8; 12];
    nonce_bytes.copy_from_slice(&nonce_vec);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext = b64.decode(env.ciphertext.trim())?;

    // Verify signature
    let sig_pk_bytes = b64.decode(env.signer_public.trim())?;
    let sig_pk = dilithium5::PublicKey::from_bytes(&sig_pk_bytes)?;
    let sig_bytes = b64.decode(env.signature.trim())?;
    let sig = dilithium5::SignedMessage::from_bytes(&sig_bytes)?;
    dilithium5::open(&sig, &sig_pk)?; // throws if invalid

    let plaintext = cipher.decrypt(nonce, ciphertext.as_ref()).map_err(|e| anyhow::anyhow!(e))?;
    println!("{}", String::from_utf8_lossy(&plaintext));
    Ok(())
}
