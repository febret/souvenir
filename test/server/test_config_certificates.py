from __future__ import annotations

from cryptography import x509

from server.certificates import ensure_certificates
from server.config import library_id, load_settings


def test_configuration_requires_media_home(monkeypatch):
    monkeypatch.delenv("SOUVENIR_MEDIA_HOME", raising=False)
    try:
        load_settings()
    except RuntimeError as error:
        assert "SOUVENIR_MEDIA_HOME is required" in str(error)
    else:
        raise AssertionError("media home should be required")


def test_configuration_uses_port_and_media_home(monkeypatch, tmp_path):
    monkeypatch.setenv("SOUVENIR_MEDIA_HOME", str(tmp_path))
    monkeypatch.setenv("SOUVENIR_PORT", "9123")
    settings = load_settings()
    assert settings.media_home == tmp_path.resolve()
    assert settings.port == 9123


def test_library_id_is_stable_distinct_and_path_safe(tmp_path):
    first_root = tmp_path / "private-library"
    second_root = tmp_path / "different-library"
    first_root.mkdir()
    second_root.mkdir()

    first_id = library_id(first_root)

    assert first_id == library_id(first_root.resolve())
    assert first_id != library_id(second_root)
    assert first_id.startswith("root-v1:")
    assert first_root.name not in first_id
    assert str(first_root.resolve()) not in first_id


def _san_hosts(certificate_path):
    certificate = x509.load_pem_x509_certificate(certificate_path.read_bytes())
    names = certificate.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
    return {
        *names.get_values_for_type(x509.DNSName),
        *(str(address) for address in names.get_values_for_type(x509.IPAddress)),
    }


def test_certificates_reuse_ca_and_reissue_expanded_sans(tmp_path):
    paths = ensure_certificates(tmp_path / "certs", {"localhost", "192.168.4.9"})
    assert paths.ca_key.is_file()
    assert _san_hosts(paths.server_certificate) == {"localhost", "192.168.4.9"}
    ca_certificate = paths.ca_certificate.read_bytes()
    ca_key = paths.ca_key.read_bytes()
    server_certificate = paths.server_certificate.read_bytes()
    server_key = paths.server_key.read_bytes()

    assert ensure_certificates(paths.directory, {"localhost"}) == paths
    assert paths.server_certificate.read_bytes() == server_certificate
    assert paths.server_key.read_bytes() == server_key

    ensure_certificates(paths.directory, {"10.20.30.40"})
    assert paths.ca_certificate.read_bytes() == ca_certificate
    assert paths.ca_key.read_bytes() == ca_key
    assert paths.server_certificate.read_bytes() != server_certificate
    assert _san_hosts(paths.server_certificate) == {"localhost", "192.168.4.9", "10.20.30.40"}
