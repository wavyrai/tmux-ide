use super::{Error, ServerClient};
use serde::Deserialize;
#[derive(Deserialize)]
struct Response {
    status: String,
    daemon: super::CatalogEventIdentity,
    capabilities: Capabilities,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Capabilities {
    #[serde(default)]
    native_surfaces: Option<Native>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Native {
    supported: bool,
    #[serde(rename = "available")]
    _available: bool,
    protocol_version: u16,
}
impl ServerClient {
    /// Optional local optimization. Unsupported/failed negotiation keeps graphics
    /// fallback; a positive answer must match the authenticated daemon identity.
    pub(super) fn native_surface_capability(&self) -> Result<bool, Error> {
        if !cfg!(target_os = "macos") {
            return Ok(false);
        }
        let Ok(local) = self.daemon.local() else {
            return Ok(false);
        };
        if self.scope().generation != local.record.instance_id {
            return Ok(false);
        }
        let response = self
            .daemon
            .post_resource("api/v2/capabilities?nativeSurfaces=1", b"{}");
        self.assert_current()?;
        local.check_record()?;
        let Ok(bytes) = response else {
            return Ok(false);
        };
        Ok(available(&bytes, &local.record))
    }
}
fn available(bytes: &[u8], record: &super::record::Record) -> bool {
    let Ok(value) = serde_json::from_slice::<Response>(bytes) else {
        return false;
    };
    value.status == "ok"
        && value.daemon.instance_id == record.instance_id
        && value.daemon.protocol_version == record.protocol_version
        && value.daemon.product_version == record.product_version
        && value.daemon.started_at == record.started_at
        && value.daemon.environment_id == record.environment_id
        && value
            .capabilities
            .native_surfaces
            .is_some_and(|v| v.supported && v.protocol_version == 116)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn positive_support_requires_exact_current_identity_and_version()
    -> Result<(), serde_json::Error> {
        let daemon = json!({"instanceId":"e01ce8ee-74d8-40d0-9a59-a096050a6ade","protocolVersion":4,
            "productVersion":"2.9.12","startedAt":"2026-10-25T00:00:00Z"});
        let mut raw = daemon.clone();
        raw["pid"] = json!(123);
        raw["port"] = json!(1234);
        raw["bindHostname"] = json!("127.0.0.1");
        raw["authToken"] = json!("fixture");
        let record = serde_json::from_value(raw)?;
        let response = json!({"status":"ok","daemon":daemon,"capabilities":{"nativeSurfaces":{"supported":true,"available":true,"protocolVersion":116}}});
        assert!(available(response.to_string().as_bytes(), &record));
        let mut waiting = response.clone();
        waiting["capabilities"]["nativeSurfaces"]["available"] = json!(false);
        assert!(available(waiting.to_string().as_bytes(), &record));
        for (key, value) in [
            ("instanceId", json!("e01ce8ee-74d8-40d0-9a59-a096050a6adf")),
            ("protocolVersion", json!(5)),
            ("productVersion", json!("different")),
            ("startedAt", json!("different")),
            (
                "environmentId",
                json!("e01ce8ee-74d8-40d0-9a59-a096050a6adf"),
            ),
        ] {
            let mut changed = response.clone();
            changed["daemon"][key] = value;
            assert!(!available(changed.to_string().as_bytes(), &record));
        }
        for support in [
            json!({"supported":false,"available":false,"protocolVersion":116}),
            json!({"supported":true,"available":true,"protocolVersion":115}),
            json!({"supported":true,"available":true,"protocolVersion":117}),
            json!(null),
        ] {
            let mut changed = response.clone();
            changed["capabilities"]["nativeSurfaces"] = support;
            assert!(!available(changed.to_string().as_bytes(), &record));
        }
        assert!(!available(b"{}", &record));
        Ok(())
    }
}
