-- Expand the canonical dependency catalog for common software-company stacks.
-- Catalog membership describes customer reality; it does not imply monitoring coverage.

alter table public.dependency_catalog
  drop constraint dependency_catalog_category_check;

alter table public.dependency_catalog
  add constraint dependency_catalog_category_check check (category in (
    'ai', 'payments', 'infrastructure', 'developer-tools', 'communications', 'other',
    'databases', 'identity', 'email', 'observability', 'analytics', 'search', 'storage',
    'crm', 'support', 'commerce', 'workflow', 'feature-flags', 'security'
  ));

-- Put existing providers into the category that best describes the service customers use.
update public.dependency_catalog set category = case slug
  when 'supabase' then 'databases'
  when 'firebase' then 'databases'
  when 'clerk' then 'identity'
  when 'auth0' then 'identity'
  when 'sentry' then 'observability'
  when 'posthog' then 'analytics'
  when 'segment' then 'analytics'
  when 'algolia' then 'search'
  when 'intercom' then 'support'
  when 'shopify' then 'commerce'
  when 'resend' then 'email'
  when 'dodo-payments' then 'payments'
  else category
end
where slug in ('supabase','firebase','clerk','auth0','sentry','posthog','segment','algolia','intercom','shopify','resend','dodo-payments');

update public.dependency_catalog
set metadata = metadata || '{"aliases":["Supabase Auth"]}'::jsonb, updated_at = now()
where slug = 'supabase';
update public.dependency_catalog
set metadata = metadata || '{"aliases":["Firebase Authentication","Firebase Auth"]}'::jsonb, updated_at = now()
where slug = 'firebase';

insert into public.dependency_catalog (slug, name, category, website_url, metadata)
values
  ('gemini-api','Google Gemini API','ai','https://ai.google.dev','{"kind":"service","aliases":["Gemini","Google AI","Google AI Studio","Gemini API"]}'::jsonb),
  ('mistral-ai','Mistral AI','ai','https://mistral.ai','{"kind":"service","aliases":["Mistral","Mistral API"]}'::jsonb),
  ('cohere','Cohere','ai','https://cohere.com','{"kind":"service","aliases":["Cohere API"]}'::jsonb),
  ('groq','Groq','ai','https://groq.com','{"kind":"service","aliases":["GroqCloud","Groq API"]}'::jsonb),
  ('replicate','Replicate','ai','https://replicate.com','{"kind":"service","aliases":["Replicate API"]}'::jsonb),
  ('hugging-face','Hugging Face','ai','https://huggingface.co','{"kind":"service","aliases":["HuggingFace","Hugging Face Inference API"]}'::jsonb),
  ('elevenlabs','ElevenLabs','ai','https://elevenlabs.io','{"kind":"service","aliases":["Eleven Labs","ElevenLabs API"]}'::jsonb),
  ('deepgram','Deepgram','ai','https://deepgram.com','{"kind":"service","aliases":["Deepgram API"]}'::jsonb),
  ('google-cloud','Google Cloud','infrastructure','https://cloud.google.com','{"kind":"service","aliases":["GCP","Google Cloud Platform"]}'::jsonb),
  ('microsoft-azure','Microsoft Azure','infrastructure','https://azure.microsoft.com','{"kind":"service","aliases":["Azure"]}'::jsonb),
  ('digitalocean','DigitalOcean','infrastructure','https://digitalocean.com','{"kind":"service","aliases":["Digital Ocean"]}'::jsonb),
  ('render','Render','infrastructure','https://render.com','{"kind":"service","aliases":[]}'::jsonb),
  ('railway','Railway','infrastructure','https://railway.com','{"kind":"service","aliases":["Railway.app"]}'::jsonb),
  ('fly-io','Fly.io','infrastructure','https://fly.io','{"kind":"service","aliases":["Fly.io"]}'::jsonb),
  ('mongodb-atlas','MongoDB Atlas','databases','https://www.mongodb.com/products/platform/atlas-database','{"kind":"service","aliases":["MongoDB","Atlas"]}'::jsonb),
  ('neon','Neon','databases','https://neon.tech','{"kind":"service","aliases":["Neon Postgres","Neon Serverless Postgres"]}'::jsonb),
  ('planetscale','PlanetScale','databases','https://planetscale.com','{"kind":"service","aliases":["PlanetScale Vitess","PlanetScale Postgres"]}'::jsonb),
  ('cockroachdb','CockroachDB','databases','https://cockroachlabs.com','{"kind":"service","aliases":["CockroachDB Cloud"]}'::jsonb),
  ('redis-cloud','Redis Cloud','databases','https://redis.io/cloud/','{"kind":"service","aliases":["Redis Enterprise Cloud"]}'::jsonb),
  ('upstash','Upstash','databases','https://upstash.com','{"kind":"service","aliases":["Upstash Redis","Upstash Kafka"]}'::jsonb),
  ('aiven','Aiven','databases','https://aiven.io','{"kind":"service","aliases":["Aiven Cloud"]}'::jsonb),
  ('timescale','Timescale','databases','https://timescale.com','{"kind":"service","aliases":["Timescale Cloud","TimescaleDB"]}'::jsonb),
  ('clickhouse-cloud','ClickHouse Cloud','databases','https://clickhouse.com/cloud','{"kind":"service","aliases":["ClickHouse"]}'::jsonb),
  ('snowflake','Snowflake','databases','https://snowflake.com','{"kind":"service","aliases":["Snowflake Cloud Data Platform"]}'::jsonb),
  ('databricks','Databricks','databases','https://databricks.com','{"kind":"service","aliases":["Databricks Lakehouse"]}'::jsonb),
  ('pinecone','Pinecone','databases','https://pinecone.io','{"kind":"service","aliases":["Pinecone vector database"]}'::jsonb),
  ('paypal','PayPal','payments','https://paypal.com','{"kind":"service","aliases":["PayPal API"]}'::jsonb),
  ('dodo-payments','Dodo Payments','payments','https://dodopayments.com','{"kind":"service","aliases":["Dodo"]}'::jsonb),
  ('paddle','Paddle','payments','https://paddle.com','{"kind":"service","aliases":["Paddle Billing"]}'::jsonb),
  ('adyen','Adyen','payments','https://adyen.com','{"kind":"service","aliases":["Adyen Payments"]}'::jsonb),
  ('mollie','Mollie','payments','https://mollie.com','{"kind":"service","aliases":["Mollie Payments"]}'::jsonb),
  ('braintree','Braintree','payments','https://braintreepayments.com','{"kind":"service","aliases":["Braintree Payments","PayPal Braintree"]}'::jsonb),
  ('lemon-squeezy','Lemon Squeezy','payments','https://lemonsqueezy.com','{"kind":"service","aliases":["LemonSqueezy"]}'::jsonb),
  ('okta','Okta','identity','https://okta.com','{"kind":"service","aliases":["Okta Identity"]}'::jsonb),
  ('workos','WorkOS','identity','https://workos.com','{"kind":"service","aliases":["WorkOS AuthKit"]}'::jsonb),
  ('microsoft-entra-id','Microsoft Entra ID','identity','https://entra.microsoft.com','{"kind":"service","aliases":["Entra ID","Azure Active Directory","Azure AD"]}'::jsonb),
  ('stytch','Stytch','identity','https://stytch.com','{"kind":"service","aliases":["Stytch B2B"]}'::jsonb),
  ('postmark','Postmark','email','https://postmarkapp.com','{"kind":"service","aliases":["Postmark Email"]}'::jsonb),
  ('sendgrid','Twilio SendGrid','email','https://sendgrid.com','{"kind":"service","aliases":["SendGrid","Twilio SendGrid"]}'::jsonb),
  ('mailgun','Mailgun','email','https://mailgun.com','{"kind":"service","aliases":["Mailgun API"]}'::jsonb),
  ('amazon-ses','Amazon SES','email','https://aws.amazon.com/ses/','{"kind":"service","aliases":["AWS SES","Simple Email Service"]}'::jsonb),
  ('brevo','Brevo','email','https://brevo.com','{"kind":"service","aliases":["Sendinblue"]}'::jsonb),
  ('mailchimp','Mailchimp','email','https://mailchimp.com','{"kind":"service","aliases":["Mailchimp Marketing"]}'::jsonb),
  ('twilio','Twilio','communications','https://twilio.com','{"kind":"service","aliases":["Twilio API"]}'::jsonb),
  ('vonage','Vonage','communications','https://vonage.com','{"kind":"service","aliases":["Vonage APIs"]}'::jsonb),
  ('slack','Slack','communications','https://slack.com','{"kind":"service","aliases":["Slack API"]}'::jsonb),
  ('discord','Discord','communications','https://discord.com','{"kind":"service","aliases":["Discord API"]}'::jsonb),
  ('microsoft-teams','Microsoft Teams','communications','https://teams.microsoft.com','{"kind":"service","aliases":["Teams","MS Teams"]}'::jsonb),
  ('ably','Ably','communications','https://ably.com','{"kind":"service","aliases":["Ably Pub/Sub"]}'::jsonb),
  ('datadog','Datadog','observability','https://datadoghq.com','{"kind":"service","aliases":["Datadog APM","Datadog Monitoring"]}'::jsonb),
  ('new-relic','New Relic','observability','https://newrelic.com','{"kind":"service","aliases":["New Relic One"]}'::jsonb),
  ('grafana-cloud','Grafana Cloud','observability','https://grafana.com/products/cloud/','{"kind":"service","aliases":["Grafana"]}'::jsonb),
  ('honeycomb','Honeycomb','observability','https://honeycomb.io','{"kind":"service","aliases":["Honeycomb.io"]}'::jsonb),
  ('better-stack','Better Stack','observability','https://betterstack.com','{"kind":"service","aliases":["BetterStack","Better Stack Logs"]}'::jsonb),
  ('pagerduty','PagerDuty','observability','https://pagerduty.com','{"kind":"service","aliases":["PagerDuty Incident Management"]}'::jsonb),
  ('amplitude','Amplitude','analytics','https://amplitude.com','{"kind":"service","aliases":["Amplitude Analytics"]}'::jsonb),
  ('mixpanel','Mixpanel','analytics','https://mixpanel.com','{"kind":"service","aliases":["Mixpanel Analytics"]}'::jsonb),
  ('google-analytics','Google Analytics','analytics','https://marketingplatform.google.com/about/analytics/','{"kind":"service","aliases":["GA4","Google Analytics 4"]}'::jsonb),
  ('plausible','Plausible Analytics','analytics','https://plausible.io','{"kind":"service","aliases":["Plausible"]}'::jsonb),
  ('heap','Heap','analytics','https://heap.io','{"kind":"service","aliases":["Heap Analytics"]}'::jsonb),
  ('hotjar','Hotjar','analytics','https://hotjar.com','{"kind":"service","aliases":["Contentsquare Hotjar"]}'::jsonb),
  ('github','GitHub','developer-tools','https://github.com','{"kind":"service","aliases":["GitHub Actions","GitHub Packages","GitHub Apps"]}'::jsonb),
  ('gitlab','GitLab','developer-tools','https://gitlab.com','{"kind":"service","aliases":["GitLab CI/CD","GitLab CI"]}'::jsonb),
  ('bitbucket','Bitbucket','developer-tools','https://bitbucket.org','{"kind":"service","aliases":["Bitbucket Pipelines"]}'::jsonb),
  ('npm','npm','developer-tools','https://npmjs.com','{"kind":"service","aliases":["npm Registry"]}'::jsonb),
  ('docker-hub','Docker Hub','developer-tools','https://hub.docker.com','{"kind":"service","aliases":["Docker Hub Registry"]}'::jsonb),
  ('terraform-cloud','HCP Terraform','developer-tools','https://terraform.io/cloud','{"kind":"service","aliases":["Terraform Cloud"]}'::jsonb),
  ('circleci','CircleCI','developer-tools','https://circleci.com','{"kind":"service","aliases":["Circle CI"]}'::jsonb),
  ('buildkite','Buildkite','developer-tools','https://buildkite.com','{"kind":"service","aliases":["Buildkite CI"]}'::jsonb),
  ('elastic-cloud','Elastic Cloud','search','https://elastic.co/cloud/','{"kind":"service","aliases":["Elastic","Elasticsearch"]}'::jsonb),
  ('typesense-cloud','Typesense Cloud','search','https://typesense.org/cloud/','{"kind":"service","aliases":["Typesense"]}'::jsonb),
  ('meilisearch-cloud','Meilisearch Cloud','search','https://meilisearch.com/cloud/','{"kind":"service","aliases":["Meilisearch"]}'::jsonb),
  ('cloudflare-r2','Cloudflare R2','storage','https://developers.cloudflare.com/r2/','{"kind":"service","aliases":["R2","Cloudflare R2 Object Storage"]}'::jsonb),
  ('google-cloud-storage','Google Cloud Storage','storage','https://cloud.google.com/storage','{"kind":"service","aliases":["GCS","Google Storage"]}'::jsonb),
  ('azure-blob-storage','Azure Blob Storage','storage','https://azure.microsoft.com/products/storage/blobs','{"kind":"service","aliases":["Azure Blob","Microsoft Azure Blob Storage"]}'::jsonb),
  ('cloudinary','Cloudinary','storage','https://cloudinary.com','{"kind":"service","aliases":["Cloudinary Media"]}'::jsonb),
  ('mux','Mux','storage','https://mux.com','{"kind":"service","aliases":["Mux Video"]}'::jsonb),
  ('hubspot','HubSpot','crm','https://hubspot.com','{"kind":"service","aliases":["HubSpot CRM"]}'::jsonb),
  ('salesforce','Salesforce','crm','https://salesforce.com','{"kind":"service","aliases":["Salesforce CRM"]}'::jsonb),
  ('pipedrive','Pipedrive','crm','https://pipedrive.com','{"kind":"service","aliases":["Pipedrive CRM"]}'::jsonb),
  ('attio','Attio','crm','https://attio.com','{"kind":"service","aliases":["Attio CRM"]}'::jsonb),
  ('zendesk','Zendesk','support','https://zendesk.com','{"kind":"service","aliases":["Zendesk Support"]}'::jsonb),
  ('freshdesk','Freshdesk','support','https://freshworks.com/freshdesk/','{"kind":"service","aliases":["Freshworks Freshdesk"]}'::jsonb),
  ('help-scout','Help Scout','support','https://helpscout.com','{"kind":"service","aliases":["HelpScout"]}'::jsonb),
  ('bigcommerce','BigCommerce','commerce','https://bigcommerce.com','{"kind":"service","aliases":["Big Commerce"]}'::jsonb),
  ('commercetools','commercetools','commerce','https://commercetools.com','{"kind":"service","aliases":["CommerceTools"]}'::jsonb),
  ('linear','Linear','workflow','https://linear.app','{"kind":"service","aliases":["Linear Issues"]}'::jsonb),
  ('jira','Jira','workflow','https://atlassian.com/software/jira','{"kind":"service","aliases":["Atlassian Jira"]}'::jsonb),
  ('notion','Notion','workflow','https://notion.so','{"kind":"service","aliases":["Notion API"]}'::jsonb),
  ('asana','Asana','workflow','https://asana.com','{"kind":"service","aliases":["Asana Work Management"]}'::jsonb),
  ('monday','monday.com','workflow','https://monday.com','{"kind":"service","aliases":["Monday.com","monday work management"]}'::jsonb),
  ('launchdarkly','LaunchDarkly','feature-flags','https://launchdarkly.com','{"kind":"service","aliases":["Launch Darkly"]}'::jsonb),
  ('statsig','Statsig','feature-flags','https://statsig.com','{"kind":"service","aliases":["Statsig Feature Flags"]}'::jsonb),
  ('configcat','ConfigCat','feature-flags','https://configcat.com','{"kind":"service","aliases":["ConfigCat Feature Flags"]}'::jsonb),
  ('fastly','Fastly','security','https://fastly.com','{"kind":"service","aliases":["Fastly CDN"]}'::jsonb),
  ('snyk','Snyk','security','https://snyk.io','{"kind":"service","aliases":["Snyk Security"]}'::jsonb),
  ('doppler','Doppler','security','https://doppler.com','{"kind":"service","aliases":["Doppler Secrets Manager"]}'::jsonb)
on conflict (slug) do update set
  name = excluded.name,
  category = excluded.category,
  website_url = excluded.website_url,
  metadata = public.dependency_catalog.metadata || excluded.metadata,
  updated_at = now();

-- Sources are provider-owned; product scope is named explicitly where a source is narrower.
-- Catalog entries without an enabled source row remain coverage-pending.
insert into public.source_catalog (dependency_id, name, source_type, url)
select provider.id, source.name, source.source_type, source.url
from (values
  ('openai','OpenAI API changelog','changelog','https://developers.openai.com/api/docs/changelog'),
  ('openai','OpenAI API deprecations','deprecation','https://developers.openai.com/api/docs/deprecations'),
  ('anthropic','Anthropic Claude release notes','changelog','https://platform.claude.com/docs/en/release-notes/overview'),
  ('anthropic','Anthropic model deprecations','deprecation','https://platform.claude.com/docs/en/about-claude/model-deprecations'),
  ('gemini-api','Gemini API changelog','changelog','https://ai.google.dev/gemini-api/docs/changelog'),
  ('stripe','Stripe API changelog','changelog','https://docs.stripe.com/changelog'),
  ('stripe','Stripe API upgrades','deprecation','https://docs.stripe.com/upgrades'),
  ('supabase','Supabase changelog','changelog','https://supabase.com/changelog'),
  ('firebase','Firebase JavaScript SDK release notes','changelog','https://firebase.google.com/support/release-notes/js'),
  ('shopify','Shopify developer changelog','changelog','https://shopify.dev/changelog'),
  ('resend','Resend changelog','changelog','https://resend.com/changelog/'),
  ('sentry','Sentry changelog','changelog','https://sentry.io/changelog/'),
  ('github','GitHub REST API breaking changes','documentation','https://docs.github.com/en/rest/about-the-rest-api/breaking-changes'),
  ('github','GitHub GraphQL breaking changes','documentation','https://docs.github.com/en/graphql/overview/breaking-changes'),
  ('hubspot','HubSpot developer changelog','changelog','https://developers.hubspot.com/changelog'),
  ('vercel','Vercel product changelog','changelog','https://vercel.com/changelog'),
  ('cloudflare','Cloudflare developer changelog','changelog','https://developers.cloudflare.com/changelog/'),
  ('digitalocean','DigitalOcean release notes','changelog','https://docs.digitalocean.com/release-notes/'),
  ('mongodb-atlas','MongoDB Atlas release notes','changelog','https://www.mongodb.com/docs/atlas/release-notes/'),
  ('gitlab','GitLab product release notes','changelog','https://about.gitlab.com/whats-new/'),
  ('slack','Slack developer changelog','changelog','https://docs.slack.dev/changelog/'),
  ('linear','Linear product changelog','changelog','https://linear.app/changelog'),
  ('twilio','Twilio product changelog','changelog','https://www.twilio.com/en-us/changelog'),
  ('posthog','PostHog product changelog','changelog','https://posthog.com/changelog'),
  ('intercom','Intercom product changes','changelog','https://www.intercom.com/changes/en'),
  ('clerk','Clerk product changelog','changelog','https://clerk.com/changelog'),
  ('auth0','Auth0 product changelog','changelog','https://auth0.com/changelog'),
  ('okta','Okta developer release notes','changelog','https://developer.okta.com/docs/release-notes/'),
  ('adyen','Adyen developer release notes','changelog','https://docs.adyen.com/release-notes'),
  ('planetscale','PlanetScale changelog','changelog','https://planetscale.com/changelog'),
  ('neon','Neon product changelog','changelog','https://neon.com/blog/category/changelog'),
  ('new-relic','New Relic product release notes','changelog','https://docs.newrelic.com/docs/release-notes/'),
  ('algolia','Algolia product changelog','changelog','https://changelog.algolia.com/')
) as source(provider_slug, name, source_type, url)
join public.dependency_catalog provider on provider.slug = source.provider_slug
on conflict (dependency_id, source_type, name) do update set
  url = excluded.url,
  updated_at = now();

create or replace function public.search_onboarding_dependency_catalog(p_workspace_id uuid,p_query text default '')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_query text := left(btrim(coalesce(p_query, '')), 80);
  v_pattern text;
  v_result jsonb;
begin
  if v_user_id is null or not exists (
    select 1 from public.workspace_members
    where workspace_id = p_workspace_id and user_id = v_user_id and role in ('owner','admin','member')
  ) then
    raise exception 'Workspace is not available to this user' using errcode = '42501';
  end if;

  -- Treat user input literally; SQL wildcard characters do not broaden results.
  v_pattern := '%' || replace(replace(replace(v_query, E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_') || '%';
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', ranked.id,
    'slug', ranked.slug,
    'name', ranked.name,
    'category', ranked.category,
    'categoryLabel', case ranked.category
      when 'ai' then 'AI'
      when 'crm' then 'CRM'
      when 'developer-tools' then 'Developer tools'
      when 'feature-flags' then 'Feature flags'
      else initcap(replace(ranked.category, '-', ' '))
    end,
    'websiteUrl', ranked.website_url,
    'authoritativeSourceCount', ranked.source_count,
    'coverageStatus', case
      when ranked.source_count = 0 then 'coverage_pending'
      when ranked.source_family_count >= 3 then 'strong_coverage'
      else 'partial_coverage'
    end
  ) order by ranked.rank, ranked.name), '[]'::jsonb)
  into v_result
  from (
    select d.id,d.slug,d.name,d.category,d.website_url,
      count(s.id)::integer as source_count,
      count(distinct s.source_type)::integer as source_family_count,
      case
        when v_query = '' then 2
        when lower(d.name) = lower(v_query) or lower(d.slug) = lower(v_query) then 0
        when exists (select 1 from jsonb_array_elements_text(coalesce(
          case when jsonb_typeof(d.metadata->'aliases')='array' then d.metadata->'aliases' end,
          '[]'::jsonb)) alias(value)
          where lower(alias.value) = lower(v_query)) then 1
        when d.name ilike v_pattern escape E'\\' or d.slug ilike v_pattern escape E'\\' then 2
        when exists (select 1 from jsonb_array_elements_text(coalesce(
          case when jsonb_typeof(d.metadata->'aliases')='array' then d.metadata->'aliases' end,
          '[]'::jsonb)) alias(value)
          where alias.value ilike v_pattern escape E'\\') then 3
        when d.category ilike v_pattern escape E'\\' then 4
        else 5
      end as rank
    from public.dependency_catalog d
    left join public.source_catalog s on s.dependency_id = d.id and s.enabled
    where d.enabled and (
      v_query = ''
      or d.name ilike v_pattern escape E'\\'
      or d.slug ilike v_pattern escape E'\\'
      or d.category ilike v_pattern escape E'\\'
      or exists (select 1 from jsonb_array_elements_text(coalesce(
        case when jsonb_typeof(d.metadata->'aliases')='array' then d.metadata->'aliases' end,
        '[]'::jsonb)) alias(value)
        where alias.value ilike v_pattern escape E'\\')
    )
    group by d.id,d.slug,d.name,d.category,d.website_url,d.metadata
    order by rank,d.name
    limit 200
  ) ranked;
  return v_result;
end;
$$;

revoke all on function public.search_onboarding_dependency_catalog(uuid,text) from public,anon;
grant execute on function public.search_onboarding_dependency_catalog(uuid,text) to authenticated;
