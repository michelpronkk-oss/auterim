-- Add bounded, provider-owned product/API update sources for high-value services.
-- Source availability describes detection eligibility, not customer impact or completeness.

do $$
begin
  if (
    select count(*)
    from public.dependency_catalog
    where enabled
      and slug = any(array[
        'cohere','mistral-ai','groq','replicate','workos','stytch',
        'microsoft-entra-id','terraform-cloud','launchdarkly','statsig',
        'honeycomb','pagerduty','databricks','snowflake','redis-cloud',
        'upstash','paddle','mollie','circleci','ably','hugging-face',
        'render','railway','cockroachdb','cloudinary','snyk','docker-hub'
      ])
  ) <> 27 then
    raise exception 'Provider catalog changed; coverage-wave source insert must be reviewed';
  end if;
end;
$$;

insert into public.source_catalog (dependency_id, name, source_type, url)
select provider.id, source.name, source.source_type, source.url
from (values
  ('cohere','Cohere API release notes','changelog','https://docs.cohere.com/v2/changelog'),
  ('mistral-ai','Mistral API and model changelog','changelog','https://docs.mistral.ai/resources/changelogs'),
  ('groq','Groq API and model changelog','changelog','https://console.groq.com/docs/changelog'),
  ('groq','Groq model deprecations','deprecation','https://console.groq.com/docs/deprecations'),
  ('replicate','Replicate platform and API changelog','changelog','https://replicate.com/changelog'),
  ('hugging-face','Hugging Face Hub changelog','changelog','https://huggingface.co/changelog'),
  ('render','Render platform changelog','changelog','https://render.com/changelog'),
  ('railway','Railway platform changelog','changelog','https://railway.com/changelog'),
  ('cockroachdb','CockroachDB Cloud SDK API changelog','changelog','https://raw.githubusercontent.com/cockroachdb/cockroach-cloud-sdk-go/main/CHANGELOG.md'),
  ('cloudinary','Cloudinary Image and Video API release notes','changelog','https://cloudinary.com/documentation/programmable_media_release_notes'),
  ('snyk','Snyk REST API changelog','changelog','https://raw.githubusercontent.com/snyk/user-docs/main/developer-tools/snyk-api/changelog.md'),
  ('docker-hub','Docker Hub API changelog','changelog','https://docs.docker.com/reference/api/hub/changelog/'),
  ('docker-hub','Docker Hub API deprecations','deprecation','https://docs.docker.com/reference/api/hub/deprecated/'),
  ('workos','WorkOS developer changelog','changelog','https://workos.com/changelog'),
  ('stytch','Stytch identity changelog','changelog','https://changelog.stytch.com/'),
  ('microsoft-entra-id','Microsoft Entra release notes','changelog','https://learn.microsoft.com/en-us/entra/fundamentals/whats-new'),
  ('terraform-cloud','HCP Terraform API changelog','changelog','https://developer.hashicorp.com/terraform/cloud-docs/api-docs/changelog'),
  ('launchdarkly','LaunchDarkly product changelog','changelog','https://launchdarkly.com/changelog/'),
  ('statsig','Statsig product updates','changelog','https://www.statsig.com/updates'),
  ('honeycomb','Honeycomb product changelog','changelog','https://changelog.honeycomb.io/'),
  ('pagerduty','PagerDuty developer API changelog','changelog','https://docs.pagerduty.com/developer/api-changelog'),
  ('databricks','Databricks platform release notes','changelog','https://docs.databricks.com/aws/en/release-notes/'),
  ('snowflake','Snowflake server and feature release notes','changelog','https://docs.snowflake.com/en/release-notes/new-features'),
  ('redis-cloud','Redis Cloud changelog','changelog','https://redis.io/docs/latest/operate/rc/changelog/'),
  ('upstash','Upstash Redis changelog','changelog','https://upstash.com/docs/redis/overall/changelog'),
  ('paddle','Paddle developer changelog','changelog','https://developer.paddle.com/changelog/'),
  ('mollie','Mollie API changelog','changelog','https://docs.mollie.com/changelog/'),
  ('circleci','CircleCI platform changelog','changelog','https://circleci.com/changelog/'),
  ('ably','Ably realtime platform changelog','changelog','https://changelog.ably.com/')
) as source(provider_slug, name, source_type, url)
join public.dependency_catalog as provider
  on provider.slug = source.provider_slug and provider.enabled
on conflict (dependency_id, source_type, name) do nothing;
