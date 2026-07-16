alter table tenants add column theme jsonb not null default '{}';

comment on column tenants.theme is
  'Personalización visual del widget: secondary_color, bg_color, font, radius, shadow, position, subtitle, logo_url, teaser, teaser_delay.';
