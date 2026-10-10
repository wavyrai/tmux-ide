//! The Alibaba Cloud OneConsole gateway shared by the Alibaba Coding Plan,
//! Alibaba Token Plan, and Qwen Cloud providers: request building, sign-in
//! token, error mapping, and field lookup in its loosely typed answers.

mod fields;
mod gateway;

pub(super) use fields::{date, expand, find_object, find_value, first, string};
pub(super) use gateway::{check, cornerstone, encode, form_body, gateway_request, sec_token};

pub(super) const CHROME_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) \
     AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";
const SAFARI_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) \
     AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.3 Safari/605.1.15";
/// Console sessions live on the aliyun and alibabacloud passport domains.
pub(super) const DOMAINS: &[&str] = &["aliyun.com", "alibabacloud.com"];
