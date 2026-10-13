/**
 * ORM models: their tables, the migrations that touch them, and Prisma's client calls.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CodeIntel } from '../src/query/intel.mjs';
import { callTool } from '../src/mcp/tools.mjs';
import { collectModels } from '../src/query/orm.mjs';
import { makeRepo, rmrf } from './helpers.mjs';

test('ORM models: tables, migrations, Prisma client calls', async (t) => {
    const root = makeRepo({
        // Prisma
        'prisma/schema.prisma': 'model User {\n  id Int @id\n  posts Post[]\n}\n\nmodel Post {\n  id Int @id\n  @@map("posts")\n}\n',
        'prisma/migrations/20240101_init/migration.sql': [
            'CREATE TABLE "User" ("id" INTEGER NOT NULL);',
            'CREATE TABLE "posts" ("id" INTEGER NOT NULL, "userId" INTEGER);',
            'CREATE UNIQUE INDEX "posts_id_key" ON "posts"("id");',
            'ALTER TABLE "posts" ADD CONSTRAINT "fk" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;',
            'UPDATE "posts" p SET "userId" = u."id" FROM "User" u;',               // 5: an aliased update, a read
            'ALTER TABLE "articles" RENAME TO "posts";',                             // 6
            '',
        ].join('\n'),
        'src/users.ts': [
            "import { prisma } from './db';",
            'export async function listUsers() {',
            '  return prisma.user.findMany();',                                  // 3
            '}',
            'export async function rename(tx: any, cache: any) {',
            '  await tx.user.update({ where: { id: 1 }, data: {} });',          // 6
            '  cache.user.update();',                                           // not a Prisma client
            '  return prisma.post.count();',                                    // 8
            '}',
            '',
        ].join('\n'),
        'src/db.ts': 'export const prisma: any = {};\n',
        // Django
        'shop/__init__.py': '',
        'shop/models.py': [
            'from django.db import models',
            'class AbstractBasket(models.Model):',
            '    class Meta:',
            '        abstract = True',
            '        app_label = "basket"',
            'class Basket(AbstractBasket):',                                     // 6
            '    pass',
            'class Line(models.Model):',
            '    class Meta:',
            '        db_table = "basket_lines"',
            'class OpenBasket(Basket):',
            '    class Meta:',
            '        proxy = True',
            'class AbstractTree(models.Model):',
            '    class Meta:',
            '        abstract = True',
            '        db_table = "shop_tree"',
            'class Tree(AbstractTree):',
            '    pass',
            '',
        ].join('\n'),
        'shop/migrations/__init__.py': '',
        'shop/migrations/0002_data.py': "def forwards(apps, schema_editor):\n    Line = apps.get_model('shop', 'Line')\n",
        'users/__init__.py': '',
        'users/models.py': 'from django.contrib.auth.models import AbstractUser\nfrom django.db import models\nclass Member(AbstractUser):\n    pass\n',
        'shop/migrations/0001_initial.py': [
            'from django.db import migrations, models',
            'class Migration(migrations.Migration):',
            '    operations = [',
            "        migrations.CreateModel(name='Basket', fields=[]),",          // 4
            "        migrations.AddField(model_name='basket', name='owner', field=models.IntegerField()),",
            "        migrations.CreateModel(name='Line', fields=[]),",
            '    ]',
            '',
        ].join('\n'),
        // SQLAlchemy + Alembic, SQLModel
        'api/models.py': [
            'from sqlalchemy.orm import DeclarativeBase',
            'from sqlmodel import SQLModel',
            'class Base(DeclarativeBase): pass',
            'class Account(Base):',
            '    __tablename__ = "accounts"',
            'class Item(SQLModel, table=True):',
            '    id: int',
            '',
        ].join('\n'),
        'api/alembic/versions/001_init.py': [
            'from alembic import op',
            'def upgrade():',
            '    op.create_table("accounts")',                                   // 3
            '    op.create_index(op.f("ix_item_name"), "item", ["name"])',       // 4
            '    op.add_column("accounts", None)',
            '',
        ].join('\n'),
        // TypeORM
        'server/role.entity.ts': [
            "import { Entity, Index } from 'typeorm';",
            "@Index('IDX_ROLE', ['name'])",
            "@Entity({ name: 'role', schema: 'core' })",
            'export class RoleEntity {}',
            '@Entity()',
            'export class AuditLogEntry {}',
            '',
        ].join('\n'),
        'server/migrations/1700-init.ts': [
            'export class Init {',
            '  async up(queryRunner: any) {',
            '    await queryRunner.query(`CREATE TABLE "core"."role" ("id" uuid)`);', // 3
            '    await queryRunner.query(`ALTER TABLE "other"."role" ADD "x" int`);',  // another schema
            "    await queryRunner.createTable('audit_log_entry');",                     // 5
            '  }',
            '}',
            '',
        ].join('\n'),
    });
    const intel = new CodeIntel({ root });
    await intel.open();
    t.after(() => { intel.close(); rmrf(root); });

    const ms = Object.fromEntries(collectModels(intel).map(m => [m.name, m]));
    const mig = (n) => ms[n].migrations.map(x => `${x.file.split('/').pop()}:${x.line} ${x.op}`);
    assert.deepEqual(Object.keys(ms).sort(), ['Account', 'AuditLogEntry', 'Basket', 'Item', 'Line', 'Member', 'OpenBasket', 'Post', 'RoleEntity', 'Tree', 'User'], 'abstract models left out; a library base (AbstractUser) recognised');
    assert.equal(ms.Tree.table, 'shop_tree', 'db_table inherited from an abstract base');
    assert.equal(ms.Member.table, 'users_member');
    assert.deepEqual(mig('Line'), ['0001_initial.py:6 CreateModel', '0002_data.py:2 get_model (data migration)']);
    assert.equal(ms.Post.table, 'posts');
    assert.deepEqual(mig('User'), ['migration.sql:1 CREATE TABLE', 'migration.sql:4 REFERENCES', 'migration.sql:5 FROM']);
    assert.deepEqual(mig('Post'), ['migration.sql:2 CREATE TABLE', 'migration.sql:3 ON', 'migration.sql:4 ALTER TABLE', 'migration.sql:5 UPDATE', 'migration.sql:6 RENAME TO']);
    assert.deepEqual(ms.User.calls.map(c => `${c.line} ${c.op} ${c.owner}`), ['3 findMany listUsers', '6 update rename'], 'prisma and tx clients, not any object');
    assert.deepEqual(ms.Post.calls.map(c => c.line), [8]);
    assert.equal(ms.Basket.table, 'basket_basket', 'app label inherited from the abstract base');
    assert.deepEqual(mig('Basket'), ['0001_initial.py:4 CreateModel', '0001_initial.py:5 AddField']);
    assert.equal(ms.Line.table, 'basket_lines');
    assert.equal(ms.OpenBasket.table, 'basket_basket', 'a proxy has its base\'s table');
    assert.deepEqual(mig('Account'), ['001_init.py:3 create_table', '001_init.py:5 add_column']);
    assert.deepEqual(mig('Item'), ['001_init.py:4 create_index'], 'SQLModel: the class name, lower-cased');
    assert.deepEqual(mig('RoleEntity'), ['1700-init.ts:3 CREATE TABLE'], 'same schema only');
    assert.equal(ms.AuditLogEntry.table, 'audit_log_entry');
    assert.deepEqual(mig('AuditLogEntry'), ['1700-init.ts:5 createTable']);

    const prisma = await callTool(intel, 'find_references', { symbol: 'User' });
    assert.match(prisma, /^Prisma model User \(prisma\/schema\.prisma:1\) — table User\nClient calls \(2 in 1 file;[\s\S]*src\/users\.ts:3 {2}findMany {2}in listUsers/);
    const django = await callTool(intel, 'find_references', { symbol: 'Basket' });
    assert.match(django, /ORM \(Django\): table basket_basket\.\nMigrations that touch it \(2 statements in 1 file\):\n {2}shop\/migrations\/0001_initial\.py:4 {2}CreateModel/);
    const ex = await callTool(intel, 'explore', { symbols: ['RoleEntity'] });
    assert.match(ex, /ORM model \(TypeORM\): table core\.role; migrations touching it: server\/migrations\/1700-init\.ts:3 CREATE TABLE/);
    assert.match(await callTool(intel, 'models', { filter: '' }), /^11 models:/);
});
