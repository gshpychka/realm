"""X.509 certificates signed by a key the cryptography library can't hold.

IAM Roles Anywhere requires (https://docs.aws.amazon.com/rolesanywhere/latest/userguide/trust-model.html):
- of the CA certificate (the trust anchor): CA:TRUE, keyCertSign;
- of a client certificate: X.509v3, CA:FALSE if present, digitalSignature;
- of both: a SHA-256 or stronger signature.
"""

import datetime
from collections.abc import Callable

from cryptography import x509
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

# Signs SHA-256(message) with the CA key; returns a DER ECDSA signature.
Signer = Callable[[bytes], bytes]

# Replaced only when the TPM2 can no longer sign with its key, or on request:
# a key that can't leave the TPM2 gains nothing from expiring, and every new
# CA has to be registered with AWS by hand.
CA_VALIDITY = datetime.timedelta(days=3650)
# leeway for AWS's clock running behind this machine's
CLOCK_SKEW = datetime.timedelta(minutes=1)

# AlgorithmIdentifier for ecdsa-with-SHA256 (1.2.840.10045.4.3.2), which has
# no parameters (RFC 5758 3.2)
ECDSA_WITH_SHA256 = bytes.fromhex("300a06082a8648ce3d040302")


def _der_length(length: int) -> bytes:
    if length < 0x80:
        return bytes([length])
    encoded = length.to_bytes((length.bit_length() + 7) // 8, "big")
    return bytes([0x80 | len(encoded)]) + encoded


def _der(tag: int, content: bytes) -> bytes:
    return bytes([tag]) + _der_length(len(content)) + content


def _signed(builder: x509.CertificateBuilder, sign: Signer) -> x509.Certificate:
    """The builder only signs with a key object, so it signs with a throwaway
    P-256 key, which yields the to-be-signed part (TBSCertificate). That names
    ecdsa-with-SHA256 as the TPM2 key's would, and holds nothing of the key
    that signed it. The TPM2 signs that part, and its signature replaces the
    throwaway one (RFC 5280 4.1):
    Certificate ::= SEQUENCE { tbsCertificate, signatureAlgorithm, signatureValue BIT STRING }
    """
    stand_in = ec.generate_private_key(ec.SECP256R1())
    tbs = builder.sign(stand_in, hashes.SHA256()).tbs_certificate_bytes
    # a BIT STRING's first octet counts unused bits: none
    signature = _der(0x03, b"\x00" + sign(tbs))
    return x509.load_der_x509_certificate(
        _der(0x30, tbs + ECDSA_WITH_SHA256 + signature)
    )


def _serial_number() -> int:
    """A random serial number of exactly 20 octets, the first 0x01 to 0x7f: its
    hex is the same 40 digits in every encoding, with no leading zero octet
    and no DER sign octet (RFC 5280 4.1.2.2 allows at most 20 octets)."""
    # random_serial_number() is below 2**159; bit 152 makes the first octet nonzero
    return x509.random_serial_number() | 1 << 152


def serial_hex(certificate: x509.Certificate) -> str:
    """The client certificate's serial number as 40 hex digits: the name of
    the Roles Anywhere session it opens."""
    return f"{certificate.serial_number:040x}"


def _key_usage(
    *, digital_signature: bool = False, cert_sign: bool = False
) -> x509.KeyUsage:
    return x509.KeyUsage(
        digital_signature=digital_signature,
        content_commitment=False,
        key_encipherment=False,
        data_encipherment=False,
        key_agreement=False,
        key_cert_sign=cert_sign,
        crl_sign=cert_sign,
        encipher_only=False,
        decipher_only=False,
    )


def ca_certificate(
    name: str, key: ec.EllipticCurvePublicKey, sign: Signer, now: datetime.datetime
) -> x509.Certificate:
    """A self-signed CA certificate for the TPM2 key."""
    subject = x509.Name(
        [x509.NameAttribute(NameOID.COMMON_NAME, f"{name} Roles Anywhere CA")]
    )
    certificate = _signed(
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(subject)
        .public_key(key)
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - CLOCK_SKEW)
        .not_valid_after(now + CA_VALIDITY)
        # path_length 0: it may sign only client certificates, never another CA
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .add_extension(_key_usage(cert_sign=True), critical=True)
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(key), critical=False),
        sign,
    )
    if not issued_by(certificate, certificate):
        raise ValueError(
            "the CA certificate's signature does not verify against its own key"
        )
    return certificate


def client_certificate(
    subject: str,
    key: ec.EllipticCurvePublicKey,
    ca: x509.Certificate,
    sign: Signer,
    now: datetime.datetime,
    lifetime: datetime.timedelta,
) -> x509.Certificate:
    """A short-lived certificate for subject's key, signed by the CA."""
    expiry = now + lifetime
    if expiry > ca.not_valid_after_utc:
        raise ValueError(
            "the CA certificate expires before the client certificate would"
        )
    certificate = _signed(
        x509.CertificateBuilder()
        # IAM Roles Anywhere maps this to aws:PrincipalTag/x509Subject/CN,
        # which each role's trust policy matches
        .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, subject)]))
        .issuer_name(ca.subject)
        .public_key(key)
        # random, so every session is distinct: Roles Anywhere names each
        # session after its certificate's serial number
        .serial_number(_serial_number())
        .not_valid_before(now - CLOCK_SKEW)
        .not_valid_after(expiry)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(_key_usage(digital_signature=True), critical=True)
        .add_extension(
            x509.ExtendedKeyUsage([ExtendedKeyUsageOID.CLIENT_AUTH]), critical=False
        )
        .add_extension(
            x509.AuthorityKeyIdentifier.from_issuer_subject_key_identifier(
                ca.extensions.get_extension_for_class(x509.SubjectKeyIdentifier).value
            ),
            critical=False,
        ),
        sign,
    )
    # A certificate AWS can't verify is useless, and a mix-up here would
    # otherwise only show as a rejection by AWS.
    if not issued_by(certificate, ca):
        raise ValueError(
            "the client certificate's signature does not verify against the CA"
        )
    return certificate


def issued_by(certificate: x509.Certificate, ca: x509.Certificate) -> bool:
    """Whether ca's key signed certificate, which names ca as its issuer."""
    try:
        certificate.verify_directly_issued_by(ca)
    except (ValueError, TypeError, InvalidSignature):
        return False
    return True


def ski(certificate: x509.Certificate) -> str:
    """The certificate's subject key identifier, as hex: the CA's name on disk and in logs."""
    return certificate.extensions.get_extension_for_class(
        x509.SubjectKeyIdentifier
    ).value.digest.hex()
