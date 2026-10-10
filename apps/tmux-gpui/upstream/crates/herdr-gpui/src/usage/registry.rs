//! Every provider, in the order the status bar and panel list them.
//! Adding one is a module in `providers/` and a line here.

use super::{model::Provider, providers, service::Service};

static SERVICES: &[&dyn Service] = &[
    &providers::codex::Codex,
    &providers::openai::Openai,
    &providers::azureopenai::Azureopenai,
    &providers::claude::Claude,
    &providers::clinepass::Clinepass,
    &providers::cursor::Cursor,
    &providers::opencode::Opencode,
    &providers::opencodego::Opencodego,
    &providers::alibaba::Alibaba,
    &providers::alibabatokenplan::Alibabatokenplan,
    &providers::qwencloud::Qwencloud,
    &providers::factory::Factory,
    &providers::fireworks::Fireworks,
    &providers::gemini::Gemini,
    &providers::antigravity::Antigravity,
    &providers::copilot::Copilot,
    &providers::devin::Devin,
    &providers::zai::Zai,
    &providers::minimax::Minimax,
    &providers::manus::Manus,
    &providers::kimi::Kimi,
    &providers::kilo::Kilo,
    &providers::kiro::Kiro,
    &providers::vertexai::Vertexai,
    &providers::augment::Augment,
    &providers::jetbrains::Jetbrains,
    &providers::moonshot::Moonshot,
    &providers::amp::Amp,
    &providers::t3chat::T3chat,
    &providers::ollama::Ollama,
    &providers::synthetic::Synthetic,
    &providers::openrouter::Openrouter,
    &providers::elevenlabs::Elevenlabs,
    &providers::warp::Warp,
    &providers::windsurf::Windsurf,
    &providers::zed::Zed,
    &providers::perplexity::Perplexity,
    &providers::mimo::Mimo,
    &providers::doubao::Doubao,
    &providers::sakana::Sakana,
    &providers::abacus::Abacus,
    &providers::mistral::Mistral,
    &providers::deepseek::Deepseek,
    &providers::deepinfra::Deepinfra,
    &providers::codebuff::Codebuff,
    &providers::venice::Venice,
    &providers::commandcode::Commandcode,
    &providers::qoder::Qoder,
    &providers::stepfun::Stepfun,
    &providers::bedrock::Bedrock,
    &providers::grok::Grok,
    &providers::groq::Groq,
    &providers::llmproxy::Llmproxy,
    &providers::litellm::Litellm,
    &providers::bifrost::Bifrost,
    &providers::aixy::Aixy,
    &providers::deepgram::Deepgram,
    &providers::poe::Poe,
    &providers::chutes::Chutes,
    &providers::neuralwatt::Neuralwatt,
    &providers::helmcode::Helmcode,
    &providers::clawrouter::Clawrouter,
    &providers::longcat::Longcat,
    &providers::sub2api::Sub2api,
    &providers::wayfinder::Wayfinder,
    &providers::zenmux::Zenmux,
    &providers::aiand::Aiand,
    &providers::zoommate::Zoommate,
    &providers::xai::Xai,
    &providers::notion::Notion,
    &providers::ibmbob::Ibmbob,
    &providers::nous::Nous,
    &providers::muse::Muse,
    &providers::coderabbit::Coderabbit,
    &providers::replicate::Replicate,
    &providers::huggingface::Huggingface,
    &providers::raycast::Raycast,
    &providers::pi::Pi,
    &providers::v0::V0,
    &providers::typesafe::Typesafe,
    &providers::hyper::Hyper,
    &providers::gitkraken::Gitkraken,
    &providers::devpass::Devpass,
    &providers::atlascloud::Atlascloud,
    &providers::vercel::Vercel,
    &providers::llmman::Llmman,
    &providers::xkiro::Xkiro,
];

pub(crate) fn all() -> impl Iterator<Item = Provider> {
    SERVICES.iter().map(|service| Provider(*service))
}

pub(crate) fn find(id: &str) -> Option<Provider> {
    all().find(|provider| provider.id() == id)
}

/// Where `provider` sits in the list, for ordering readings.
pub(crate) fn position(provider: Provider) -> usize {
    SERVICES
        .iter()
        .position(|service| service.meta().id == provider.id())
        .unwrap_or(SERVICES.len())
}
