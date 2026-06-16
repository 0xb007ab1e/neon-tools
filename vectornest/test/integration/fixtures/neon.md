# Neon serverless Postgres

Neon is serverless Postgres. Its scale-to-zero feature means an idle database costs nothing:
the compute suspends automatically after a period of inactivity and resumes on the next
connection. Copy-on-write branching lets you create a full, isolated copy of a database almost
instantly and nearly for free, which is ideal for development, testing, and previews.
