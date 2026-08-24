from __future__ import annotations

import ipaddress
import socket
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID


@dataclass(frozen=True)
class CertificatePaths:
    directory: Path
    ca_certificate: Path
    ca_key: Path
    server_certificate: Path
    server_key: Path


def local_addresses() -> set[str]:
    addresses = {"127.0.0.1", "::1", "localhost"}
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None):
            address = info[4][0].split("%")[0]
            ipaddress.ip_address(address)
            addresses.add(address)
    except OSError:
        pass
    # A UDP connect asks the operating system for its selected LAN address without sending data.
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("8.8.8.8", 80))
            addresses.add(sock.getsockname()[0])
    except OSError:
        pass
    return addresses


def ensure_certificates(directory: str | Path, hosts: set[str] | None = None) -> CertificatePaths:
    directory = Path(directory)
    paths = CertificatePaths(
        directory,
        directory / "ca.pem",
        directory / "ca-key.pem",
        directory / "server.pem",
        directory / "server-key.pem",
    )
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    requested_hosts = hosts or local_addresses()
    ca_files_exist = paths.ca_certificate.is_file() or paths.ca_key.is_file()
    if ca_files_exist and not (paths.ca_certificate.is_file() and paths.ca_key.is_file()):
        raise RuntimeError("Souvenir CA certificate and private key must be kept together")

    if ca_files_exist:
        ca_cert = x509.load_pem_x509_certificate(paths.ca_certificate.read_bytes())
        ca_key = serialization.load_pem_private_key(paths.ca_key.read_bytes(), password=None)
    else:
        ca_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        ca_subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Souvenir Local CA")])
        now = datetime.now(timezone.utc)
        ca_cert = (
            x509.CertificateBuilder().subject_name(ca_subject).issuer_name(ca_subject)
            .public_key(ca_key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now - timedelta(minutes=1)).not_valid_after(now + timedelta(days=3650))
            .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
            .add_extension(x509.KeyUsage(digital_signature=True, key_cert_sign=True, crl_sign=True,
                                     key_encipherment=False, data_encipherment=False, key_agreement=False,
                                     content_commitment=False, encipher_only=False, decipher_only=False), critical=True)
            .sign(ca_key, hashes.SHA256())
        )
        paths.ca_certificate.write_bytes(ca_cert.public_bytes(serialization.Encoding.PEM))
        paths.ca_key.write_bytes(_private_key_bytes(ca_key))
        paths.ca_key.chmod(0o600)

    existing_hosts = _certificate_hosts(paths.server_certificate) if paths.server_certificate.is_file() else set()
    if paths.server_key.is_file() and requested_hosts <= existing_hosts:
        return paths
    _issue_server_certificate(paths, ca_cert, ca_key, existing_hosts | requested_hosts)
    return paths


def _certificate_hosts(path: Path) -> set[str]:
    certificate = x509.load_pem_x509_certificate(path.read_bytes())
    try:
        names = certificate.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
    except x509.ExtensionNotFound:
        return set()
    return {
        *(str(address) for address in names.get_values_for_type(x509.IPAddress)),
        *names.get_values_for_type(x509.DNSName),
    }


def _issue_server_certificate(
    paths: CertificatePaths,
    ca_cert: x509.Certificate,
    ca_key: rsa.RSAPrivateKey,
    hosts: set[str],
) -> None:
    now = datetime.now(timezone.utc)
    server_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    san_names = []
    for host in sorted(hosts):
        try:
            san_names.append(x509.IPAddress(ipaddress.ip_address(host)))
        except ValueError:
            san_names.append(x509.DNSName(host))
    server_cert = (
        x509.CertificateBuilder().subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "localhost")]))
        .issuer_name(ca_cert.subject).public_key(server_key.public_key()).serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(minutes=1)).not_valid_after(now + timedelta(days=825))
        .add_extension(x509.SubjectAlternativeName(san_names), critical=False)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
        .sign(ca_key, hashes.SHA256())
    )
    paths.server_certificate.write_bytes(server_cert.public_bytes(serialization.Encoding.PEM))
    paths.server_key.write_bytes(_private_key_bytes(server_key))
    paths.server_key.chmod(0o600)


def _private_key_bytes(key: rsa.RSAPrivateKey) -> bytes:
    return key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.TraditionalOpenSSL,
        serialization.NoEncryption(),
    )
