require('dotenv').config();

const sqlite3 = require('sqlite3').verbose();
const {
    Client,
    GatewayIntentBits,
    ChannelType,
    PermissionFlagsBits,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    MessageFlags,
    RoleSelectMenuBuilder,
    ChannelSelectMenuBuilder
} = require('discord.js');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// ==========================================
// DATABASE SETUP (Railway Volume Fix)
// ==========================================
// IMPORTANT: If your config resets on Railway, it means your Volume is not mounted correctly.
// Go to Railway -> Variables and add DB_PATH = /data/data.sqlite
const dbPath = process.env.DB_PATH || './data.sqlite';
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) console.error('Error opening database:', err);
    else console.log(`📁 Connected to SQLite database at: ${dbPath}`);
});

db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS settings (
            guild_id TEXT PRIMARY KEY,
            category_id TEXT,
            log_channel_id TEXT,
            staff_roles TEXT,
            application_rules TEXT,
            application_questions TEXT,
            panel_message TEXT,
            approval_message TEXT,
            denial_message TEXT
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS applications (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            guild_app_number INTEGER,
            guild_id TEXT,
            user_id TEXT,
            channel_id TEXT,
            reviewer_id TEXT,
            status TEXT,
            denial_reason TEXT,
            reviewed_at INTEGER
        )
    `);

    // ROBUST MIGRATION: Check for missing columns and add them safely
    const ensureColumn = (table, column, type) => {
        db.all(`PRAGMA table_info(${table})`, (err, rows) => {
            if (err || !rows) return;
            const exists = rows.some(r => r.name === column);
            if (!exists) {
                db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`, (alterErr) => {
                    if (alterErr) console.error(`Error adding ${column} to ${table}:`, alterErr);
                    else console.log(`✅ Added missing column ${column} to ${table}`);
                });
            }
        });
    };

    ensureColumn('settings', 'application_questions', 'TEXT');
    ensureColumn('settings', 'panel_message', 'TEXT');
    ensureColumn('settings', 'approval_message', 'TEXT');
    ensureColumn('settings', 'denial_message', 'TEXT');
    ensureColumn('applications', 'guild_id', 'TEXT');
    ensureColumn('applications', 'guild_app_number', 'INTEGER');
    ensureColumn('applications', 'reviewed_at', 'INTEGER');
});

// ==========================================
// HELPER FUNCTIONS
// ==========================================
function getSettings(guildId) {
    return new Promise((resolve, reject) => {
        db.get(`SELECT * FROM settings WHERE guild_id=?`, [guildId], (err, row) => {
            if (err) return reject(err);
            resolve(row);
        });
    });
}

function getApplication(id) {
    return new Promise((resolve, reject) => {
        db.get(`SELECT * FROM applications WHERE id=?`, [id], (err, row) => {
            if (err) return reject(err);
            resolve(row);
        });
    });
}

function getActiveApplication(userId, guildId) {
    return new Promise((resolve, reject) => {
        db.get(`SELECT * FROM applications WHERE user_id=? AND guild_id=? AND status='PENDING'`, [userId, guildId], (err, row) => {
            if (err) return reject(err);
            resolve(row);
        });
    });
}

function isStaff(member, settings) {
    if (!member || !settings || !settings.staff_roles) return false;
    try {
        const roles = JSON.parse(settings.staff_roles);
        return roles.some(roleId => member.roles.cache.has(roleId));
    } catch {
        return false;
    }
}

function logTranscript(guild, settings, appNumber, applicantId, reviewerId, decision, reason = null) {
    if (!settings || !settings.log_channel_id) return;
    const channel = guild.channels.cache.get(settings.log_channel_id);
    if (!channel) return;

    const botMember = guild.members.me;
    if (botMember && !channel.permissionsFor(botMember)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
        console.log(`[WARNING] Missing permissions to log transcript in #${channel.name}`);
        return;
    }

    const embed = new EmbedBuilder()
        .setColor(decision === 'APPROVED' ? '#57F287' : '#ED4245')
        .setTitle('📄 Application Decision Transcript')
        .addFields(
            { name: 'Application Number', value: `#${String(appNumber).padStart(4, '0')}`, inline: false },
            { name: 'Applicant', value: `<@${applicantId}>`, inline: false },
            { name: 'Reviewed By', value: `<@${reviewerId}>`, inline: false },
            { name: 'Decision', value: `**${decision}**`, inline: false }
        )
        .setTimestamp();

    if (reason) {
        embed.addFields({ name: 'Reason for Denial', value: reason, inline: false });
    }

    channel.send({ embeds: [embed] }).catch(() => {});
}

function sendDiagnosticError(channel, errorMsg) {
    const errorEmbed = new EmbedBuilder()
        .setColor('#ED4245')
        .setTitle('⚠️ System Error Diagnosed')
        .setDescription(`The bot encountered an error while trying to process this application.\n\n**Diagnosis:**\n${errorMsg}\n\n**What to do:**\nPlease go to the main FVRRP server and submit a ticket with this error screenshotted so staff can assist you.`)
        .setTimestamp();
    
    channel.send({ embeds: [errorEmbed] }).catch(() => {});
}

function scheduleAutoClose(channel, days = 7) {
    const ms = days * 24 * 60 * 60 * 1000;
    setTimeout(async () => {
        await channel.delete().catch(() => {});
    }, ms);
}

// ==========================================
// STARTUP CLEANUP
// ==========================================
client.once('clientReady', async () => {
    console.log(`Logged in as ${client.user.tag}`);

    const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
    
    db.all(`SELECT * FROM applications WHERE status IN ('APPROVED', 'DENIED') AND reviewed_at IS NOT NULL AND reviewed_at < ?`, [sevenDaysAgo], async (err, rows) => {
        if (err || !rows) return;
        
        for (const app of rows) {
            if (app.channel_id) {
                const channel = client.channels.cache.get(app.channel_id);
                if (channel) {
                    await channel.delete().catch(() => {});
                    console.log(`Auto-closed old application #${app.guild_app_number || app.id} on startup.`);
                }
            }
        }
    });
});

// ==========================================
// UI BUILDERS
// ==========================================
function buildStep1() {
    const embed = new EmbedBuilder()
        .setColor('#2b2d31')
        .setTitle('Step 1: Channel Configuration')
        .setDescription('Please select the **Category** where application channels will be created, and the **Logs Channel** where transcripts will be saved.\n\nUse the menus below.');

    const catSelect = new ChannelSelectMenuBuilder()
        .setCustomId('select_category')
        .setPlaceholder('Select Application Category')
        .setChannelTypes([ChannelType.GuildCategory]);

    const logSelect = new ChannelSelectMenuBuilder()
        .setCustomId('select_logs')
        .setPlaceholder('Select Transcripts Log Channel')
        .setChannelTypes([ChannelType.GuildText]);

    const row1 = new ActionRowBuilder().addComponents(catSelect);
    const row2 = new ActionRowBuilder().addComponents(logSelect);
    const row3 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('step1_next').setLabel('Next').setStyle(ButtonStyle.Primary)
    );

    return { embeds: [embed], components: [row1, row2, row3] };
}

function buildStep2() {
    const embed = new EmbedBuilder()
        .setColor('#2b2d31')
        .setTitle('Step 2: Application Rules')
        .setDescription('Please enter the **Application Rules**. These are the guidelines applicants must follow (e.g., "Be respectful", "Provide accurate information").\n\nClick the button below to open the text editor.');

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('back_to_step1').setLabel('Back').setStyle(ButtonStyle.Secondary).setEmoji('⬅️'),
        new ButtonBuilder().setCustomId('edit_rules').setLabel('Edit Rules').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('step2_next').setLabel('Next').setStyle(ButtonStyle.Success)
    );

    return { embeds: [embed], components: [row] };
}

function buildStep3() {
    const embed = new EmbedBuilder()
        .setColor('#2b2d31')
        .setTitle('Step 3: Application Questions')
        .setDescription('Please enter the **Application Questions**. These are the questions the applicant must answer in their ticket (e.g., "What is your age?", "Why do you want to join?").\n\nClick the button below to open the text editor.');

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('back_to_step2').setLabel('Back').setStyle(ButtonStyle.Secondary).setEmoji('⬅️'),
        new ButtonBuilder().setCustomId('edit_questions').setLabel('Edit Questions').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('step3_next').setLabel('Next').setStyle(ButtonStyle.Success)
    );

    return { embeds: [embed], components: [row] };
}

function buildStep4() {
    const embed = new EmbedBuilder()
        .setColor('#2b2d31')
        .setTitle('Step 4: Staff Roles')
        .setDescription('Select the roles that should have access to review applications and view transcripts.\n\nUse the dropdown to select your staff roles.');

    const roleSelect = new RoleSelectMenuBuilder()
        .setCustomId('select_staff_roles')
        .setPlaceholder('Select Staff Roles')
        .setMinValues(1)
        .setMaxValues(5);

    const row1 = new ActionRowBuilder().addComponents(roleSelect);
    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('back_to_step3').setLabel('Back').setStyle(ButtonStyle.Secondary).setEmoji('⬅️'),
        new ButtonBuilder().setCustomId('step4_next').setLabel('Next').setStyle(ButtonStyle.Success)
    );

    return { embeds: [embed], components: [row1, row2] };
}

function buildStep5() {
    const embed = new EmbedBuilder()
        .setColor('#2b2d31')
        .setTitle('Step 5: Approval & Denial Messages')
        .setDescription('Please set the messages that will be sent to the applicant when their application is reviewed.\n\n**Best Practice:** Use this space to let the applicant know what their next steps are (e.g., "Join the server", "Wait for a ping from staff").\n\nUse the buttons below to edit them.');

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('back_to_step4').setLabel('Back').setStyle(ButtonStyle.Secondary).setEmoji('⬅️'),
        new ButtonBuilder().setCustomId('edit_approval').setLabel('Edit Approval Message').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('edit_denial').setLabel('Edit Denial Message').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('step5_next').setLabel('Next').setStyle(ButtonStyle.Success)
    );

    return { embeds: [embed], components: [row] };
}

function buildStep6() {
    const embed = new EmbedBuilder()
        .setColor('#2b2d31')
        .setTitle('Step 6: Application Panel Description')
        .setDescription('Finally, set the description that will appear on the panel where users click to apply.\n\nThis is what users will see **before** making a ticket, so it should be clear, welcoming, and showcase what they are applying to.\n\nClick the button below to open the text editor.');

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('back_to_step5').setLabel('Back').setStyle(ButtonStyle.Secondary).setEmoji('⬅️'),
        new ButtonBuilder().setCustomId('edit_panel').setLabel('Edit Panel Description').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('step6_finish').setLabel('Finish Setup').setStyle(ButtonStyle.Success)
    );

    return { embeds: [embed], components: [row] };
}

// ==========================================
// INTERACTION HANDLER
// ==========================================
client.on('interactionCreate', async interaction => {
    try {
        // ==========================================
        // /HELP COMMAND
        // ==========================================
        if (interaction.isChatInputCommand() && interaction.commandName === 'help') {
            const embed = new EmbedBuilder()
                .setColor('#5865F2')
                .setTitle('📚 FVRRP Applications Bot - Help Guide')
                .setDescription('Here is a list of all the commands available to configure and manage the application system.')
                .addFields(
                    { name: '⚙️ Configuration & Setup', value: '`/dashboard` - Opens the step-by-step wizard to configure the bot.\n`/config` - Views the current bot configuration for this server.', inline: false },
                    { name: '✏️ Individual Editing', value: '`/edit_channels` - Updates the ticket category and logs channel.\n`/edit_rules` - Updates the application rules.\n`/edit_questions` - Updates the application questions.\n`/edit_roles` - Updates the staff roles that can review applications.\n`/edit_messages` - Updates the approval and denial messages.\n`/edit_panel` - Updates the panel description shown before applying.', inline: false },
                    { name: '🛠️ Deployment & Management', value: '`/deploy` - Sends the application panel to the current channel.\n`/forceclose` - Force closes and deletes the current ticket channel.\n`/purge` - Deletes all completed application channels tracked in the database.\n`/reset` - Clears a stuck application for a specific user.', inline: false },
                    { name: '❓ Utility', value: '`/help` - Shows this help menu.', inline: false }
                )
                .setFooter({ text: 'FVRRP Applications Bot', iconURL: client.user.displayAvatarURL() });

            return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
        }

        // ==========================================
        // /DASHBOARD COMMAND
        // ==========================================
        if (interaction.isChatInputCommand() && interaction.commandName === 'dashboard') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            return interaction.editReply(buildStep1());
        }

        // ==========================================
        // /FORCECLOSE COMMAND (Now handles orphaned channels)
        // ==========================================
        if (interaction.isChatInputCommand() && interaction.commandName === 'forceclose') {
            const channelId = interaction.channel.id;
            const settings = await getSettings(interaction.guild.id);
            
            db.get(`SELECT * FROM applications WHERE channel_id = ?`, [channelId], async (err, row) => {
                // If it's in the DB, handle normally
                if (row) {
                    if (row.status === 'PENDING') {
                        db.run(`DELETE FROM applications WHERE channel_id = ?`, [channelId]);
                        await interaction.reply({ content: 'Force closing channel and clearing pending application data in 3 seconds...', flags: MessageFlags.Ephemeral });
                    } else {
                        await interaction.reply({ content: 'Force closing completed application channel in 3 seconds... (Data retained)', flags: MessageFlags.Ephemeral });
                    }
                    setTimeout(() => interaction.channel.delete().catch(() => {}), 3000);
                    return;
                }

                // If it's NOT in the DB, but it's in the application category, it's an orphaned ticket. Delete it.
                if (settings && settings.category_id && interaction.channel.parentId === settings.category_id) {
                    await interaction.reply({ content: 'Force closing orphaned application channel in 3 seconds...', flags: MessageFlags.Ephemeral });
                    setTimeout(() => interaction.channel.delete().catch(() => {}), 3000);
                    return;
                }

                // If it's not in the DB AND not in the category, refuse.
                return interaction.reply({ 
                    content: '❌ **Error:** This is not an application channel. I cannot force close it.', 
                    flags: MessageFlags.Ephemeral 
                });
            });
            return;
        }

        // ==========================================
        // /PURGE COMMAND
        // ==========================================
        if (interaction.isChatInputCommand() && interaction.commandName === 'purge') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            
            db.all(`SELECT * FROM applications WHERE status IN ('APPROVED', 'DENIED', 'CLOSED') AND guild_id = ?`, [interaction.guild.id], async (err, rows) => {
                if (err || !rows) return interaction.editReply({ content: '❌ Error fetching completed applications.' });

                let count = 0;
                for (const row of rows) {
                    if (row.channel_id) {
                        const channel = interaction.guild.channels.cache.get(row.channel_id);
                        if (channel) {
                            await channel.delete().catch(() => {});
                            count++;
                        }
                    }
                }
                return interaction.editReply({ content: `✅ Successfully purged **${count}** completed application channels created by the bot. Database records have been kept intact.` });
            });
            return;
        }

        // ==========================================
        // /RESET COMMAND
        // ==========================================
        if (interaction.isChatInputCommand() && interaction.commandName === 'reset') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const targetUser = interaction.options.getUser('user');

            db.get(`SELECT * FROM applications WHERE user_id = ? AND guild_id = ? AND status = 'PENDING'`, [targetUser.id, interaction.guild.id], async (err, row) => {
                if (err || !row) {
                    return interaction.editReply({ content: `❌ No pending application found for <@${targetUser.id}> in the database.` });
                }

                db.run(`DELETE FROM applications WHERE id = ?`, [row.id]);

                if (row.channel_id) {
                    const channel = interaction.guild.channels.cache.get(row.channel_id);
                    if (channel) {
                        await channel.delete().catch(() => {});
                    }
                }

                return interaction.editReply({ content: `✅ Successfully reset the pending application for <@${targetUser.id}>. They can now apply again.` });
            });
            return;
        }

        // ==========================================
        // /DEPLOY COMMAND
        // ==========================================
        if (interaction.isChatInputCommand() && interaction.commandName === 'deploy') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const settings = await getSettings(interaction.guild.id);
            
            if (!settings || !settings.category_id || !settings.application_rules || !settings.application_questions) {
                return interaction.editReply({ content: '❌ You must configure the bot via `/dashboard` first.' });
            }

            const embed = new EmbedBuilder()
                .setColor('#5865F2')
                .setTitle('📝 Application Form')
                .setDescription(settings.panel_message || 'Click the button below to apply.')
                .setFooter({ text: interaction.guild.name, iconURL: interaction.guild.iconURL() });

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('apply').setLabel('Apply Now').setStyle(ButtonStyle.Primary).setEmoji('📩')
            );

            await interaction.channel.send({ embeds: [embed], components: [row] });
            return interaction.editReply({ content: '✅ Application panel deployed.' });
        }

        // ==========================================
        // /CONFIG COMMAND
        // ==========================================
        if (interaction.isChatInputCommand() && interaction.commandName === 'config') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const settings = await getSettings(interaction.guild.id);

            if (!settings || !settings.category_id) {
                return interaction.editReply({ content: '❌ No configuration found. Please run `/dashboard` to start.' });
            }

            const rolesMentions = settings.staff_roles ? JSON.parse(settings.staff_roles).map(id => `<@&${id}>`).join(', ') : 'None';

            const embed = new EmbedBuilder()
                .setColor('#2b2d31')
                .setTitle('⚙️ Current Configuration')
                .addFields(
                    { name: 'Category', value: `<#${settings.category_id}>`, inline: true },
                    { name: 'Logs Channel', value: `<#${settings.log_channel_id}>`, inline: true },
                    { name: 'Staff Roles', value: rolesMentions || 'None', inline: false },
                    { name: 'Application Rules', value: settings.application_rules ? `\`\`\`${settings.application_rules.substring(0, 1000)}\`\`\`` : 'Not set', inline: false },
                    { name: 'Application Questions', value: settings.application_questions ? `\`\`\`${settings.application_questions.substring(0, 1000)}\`\`\`` : 'Not set', inline: false },
                    { name: 'Approval Message', value: settings.approval_message ? `\`\`\`${settings.approval_message.substring(0, 1000)}\`\`\`` : 'Default', inline: false },
                    { name: 'Denial Message', value: settings.denial_message ? `\`\`\`${settings.denial_message.substring(0, 1000)}\`\`\`` : 'Default', inline: false },
                    { name: 'Panel Description', value: settings.panel_message ? `\`\`\`${settings.panel_message.substring(0, 1000)}\`\`\`` : 'Not set', inline: false }
                )
                .setFooter({ text: 'Use /edit_... commands to change these settings.' });

            return interaction.editReply({ embeds: [embed] });
        }

        // ==========================================
        // INDIVIDUAL EDIT COMMANDS
        // ==========================================
        if (interaction.isChatInputCommand() && interaction.commandName.startsWith('edit_')) {
            const settings = await getSettings(interaction.guild.id);

            if (!settings || !settings.category_id) {
                return interaction.reply({ content: '❌ You must run `/dashboard` first before editing individual settings.', flags: MessageFlags.Ephemeral });
            }

            if (interaction.commandName === 'edit_channels') {
                const catSelect = new ChannelSelectMenuBuilder().setCustomId('edit_select_category').setPlaceholder('Select New Application Category').setChannelTypes([ChannelType.GuildCategory]);
                const logSelect = new ChannelSelectMenuBuilder().setCustomId('edit_select_logs').setPlaceholder('Select New Logs Channel').setChannelTypes([ChannelType.GuildText]);
                const row1 = new ActionRowBuilder().addComponents(catSelect);
                const row2 = new ActionRowBuilder().addComponents(logSelect);
                return interaction.reply({ content: 'Please select the new channels below:', components: [row1, row2], flags: MessageFlags.Ephemeral });
            }

            if (interaction.commandName === 'edit_roles') {
                const roleSelect = new RoleSelectMenuBuilder().setCustomId('edit_select_roles').setPlaceholder('Select New Staff Roles').setMinValues(1).setMaxValues(5);
                const row = new ActionRowBuilder().addComponents(roleSelect);
                return interaction.reply({ content: 'Please select the new staff roles below:', components: [row], flags: MessageFlags.Ephemeral });
            }

            if (interaction.commandName === 'edit_rules') {
                const modal = new ModalBuilder().setCustomId('modal_edit_rules').setTitle('Edit Application Rules');
                const textInput = new TextInputBuilder().setCustomId('rules_text').setLabel('Application Rules').setStyle(TextInputStyle.Paragraph).setRequired(true).setValue(settings.application_rules || '1. Be respectful.');
                modal.addComponents(new ActionRowBuilder().addComponents(textInput));
                return interaction.showModal(modal);
            }

            if (interaction.commandName === 'edit_questions') {
                const modal = new ModalBuilder().setCustomId('modal_edit_questions').setTitle('Edit Application Questions');
                const textInput = new TextInputBuilder().setCustomId('questions_text').setLabel('Questions to Answer').setStyle(TextInputStyle.Paragraph).setRequired(true).setValue(settings.application_questions || '1. What is your age?');
                modal.addComponents(new ActionRowBuilder().addComponents(textInput));
                return interaction.showModal(modal);
            }

            if (interaction.commandName === 'edit_messages') {
                const modal = new ModalBuilder().setCustomId('modal_edit_messages').setTitle('Edit Approval & Denial Messages');
                const approvalInput = new TextInputBuilder().setCustomId('approval_text').setLabel('Approval Message').setStyle(TextInputStyle.Paragraph).setRequired(true).setValue(settings.approval_message || 'Congratulations! Your application has been approved.');
                const denialInput = new TextInputBuilder().setCustomId('denial_text').setLabel('Denial Message').setStyle(TextInputStyle.Paragraph).setRequired(true).setValue(settings.denial_message || 'We regret to inform you that your application has been denied.');
                modal.addComponents(new ActionRowBuilder().addComponents(approvalInput), new ActionRowBuilder().addComponents(denialInput));
                return interaction.showModal(modal);
            }

            if (interaction.commandName === 'edit_panel') {
                const modal = new ModalBuilder().setCustomId('modal_edit_panel').setTitle('Edit Panel Description');
                const textInput = new TextInputBuilder().setCustomId('panel_text').setLabel('Panel Description').setStyle(TextInputStyle.Paragraph).setRequired(true).setValue(settings.panel_message || 'Welcome! Click below to apply.');
                modal.addComponents(new ActionRowBuilder().addComponents(textInput));
                return interaction.showModal(modal);
            }
        }

        // ==========================================
        // WIZARD BUTTONS & NAVIGATION
        // ==========================================
        if (interaction.isButton()) {
            if (interaction.customId === 'step1_next') return interaction.update(buildStep2());
            if (interaction.customId === 'step2_next') return interaction.update(buildStep3());
            if (interaction.customId === 'step3_next') return interaction.update(buildStep4());
            if (interaction.customId === 'step4_next') return interaction.update(buildStep5());
            if (interaction.customId === 'step5_next') return interaction.update(buildStep6());
            
            if (interaction.customId === 'back_to_step1') return interaction.update(buildStep1());
            if (interaction.customId === 'back_to_step2') return interaction.update(buildStep2());
            if (interaction.customId === 'back_to_step3') return interaction.update(buildStep3());
            if (interaction.customId === 'back_to_step4') return interaction.update(buildStep4());
            if (interaction.customId === 'back_to_step5') return interaction.update(buildStep5());
            
            if (interaction.customId === 'step6_finish') {
                return interaction.update({ content: '✅ **Setup Complete!** Your application system is now fully configured. Use `/deploy` in the channel where you want the application panel to appear.', embeds: [], components: [] });
            }

            if (interaction.customId === 'edit_rules') {
                const settings = await getSettings(interaction.guild.id) || {};
                const modal = new ModalBuilder().setCustomId('modal_edit_rules').setTitle('Edit Application Rules');
                const textInput = new TextInputBuilder().setCustomId('rules_text').setLabel('Application Rules').setStyle(TextInputStyle.Paragraph).setRequired(true).setValue(settings.application_rules || '1. Be respectful.');
                modal.addComponents(new ActionRowBuilder().addComponents(textInput));
                return interaction.showModal(modal);
            }

            if (interaction.customId === 'edit_questions') {
                const settings = await getSettings(interaction.guild.id) || {};
                const modal = new ModalBuilder().setCustomId('modal_edit_questions').setTitle('Edit Application Questions');
                const textInput = new TextInputBuilder().setCustomId('questions_text').setLabel('Questions to Answer').setStyle(TextInputStyle.Paragraph).setRequired(true).setValue(settings.application_questions || '1. What is your age?');
                modal.addComponents(new ActionRowBuilder().addComponents(textInput));
                return interaction.showModal(modal);
            }

            if (interaction.customId === 'edit_approval' || interaction.customId === 'edit_denial') {
                const settings = await getSettings(interaction.guild.id) || {};
                const modal = new ModalBuilder().setCustomId('modal_edit_messages').setTitle('Edit Messages');
                const approvalInput = new TextInputBuilder().setCustomId('approval_text').setLabel('Approval Message').setStyle(TextInputStyle.Paragraph).setRequired(true).setValue(settings.approval_message || 'Congratulations! Your application has been approved.');
                const denialInput = new TextInputBuilder().setCustomId('denial_text').setLabel('Denial Message').setStyle(TextInputStyle.Paragraph).setRequired(true).setValue(settings.denial_message || 'We regret to inform you that your application has been denied.');
                modal.addComponents(new ActionRowBuilder().addComponents(approvalInput), new ActionRowBuilder().addComponents(denialInput));
                return interaction.showModal(modal);
            }

            if (interaction.customId === 'edit_panel') {
                const settings = await getSettings(interaction.guild.id) || {};
                const modal = new ModalBuilder().setCustomId('modal_edit_panel').setTitle('Edit Panel Description');
                const textInput = new TextInputBuilder().setCustomId('panel_text').setLabel('Panel Description').setStyle(TextInputStyle.Paragraph).setRequired(true).setValue(settings.panel_message || 'Welcome! Click below to apply.');
                modal.addComponents(new ActionRowBuilder().addComponents(textInput));
                return interaction.showModal(modal);
            }

            // ARCHIVE BUTTON
            if (interaction.customId.startsWith('archive_')) {
                const settings = await getSettings(interaction.guild.id);
                const member = interaction.member || await interaction.guild.members.fetch(interaction.user.id);
                
                if (!isStaff(member, settings)) return interaction.reply({ content: 'Only staff can archive applications.', flags: MessageFlags.Ephemeral });

                const logChannel = interaction.guild.channels.cache.get(settings.log_channel_id);
                if (!logChannel) {
                    return interaction.reply({ content: '❌ The logs channel set in the configuration no longer exists. Please update it using `/edit_channels`.', flags: MessageFlags.Ephemeral });
                }

                const botMember = interaction.guild.members.me;
                if (!logChannel.permissionsFor(botMember)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
                    return interaction.reply({ 
                        content: `❌ **Missing Access:** I do not have permission to view or send messages in the logs channel (<#${logChannel.id}>). Please check my permissions and try again.`, 
                        flags: MessageFlags.Ephemeral 
                    });
                }

                await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                
                const messages = await interaction.channel.messages.fetch({ limit: 100 });
                const sortedMessages = Array.from(messages.values()).reverse();
                
                let transcriptText = '';
                sortedMessages.forEach(msg => {
                    if (msg.content) transcriptText += `[${msg.createdAt.toLocaleString()}] ${msg.author.tag}: ${msg.content}\n`;
                    if (msg.embeds.length > 0) msg.embeds.forEach(e => transcriptText += `[${msg.createdAt.toLocaleString()}] ${msg.author.tag} (EMBED): ${e.title || ''} - ${e.description || ''}\n`);
                });

                if (transcriptText.length > 1900) transcriptText = transcriptText.substring(0, 1900) + '\n...[Transcript Truncated]';

                const archiveEmbed = new EmbedBuilder()
                    .setColor('#FEE75C')
                    .setTitle('📦 Application Archived')
                    .setDescription(`Transcript for channel **#${interaction.channel.name}** archived by ${interaction.user}.\n\`\`\`\n${transcriptText || 'No text messages found.'}\n\`\`\``)
                    .setTimestamp();

                await logChannel.send({ embeds: [archiveEmbed] });
                return interaction.editReply({ content: '✅ Application archived to logs.' });
            }
        }

        // ==========================================
        // CHANNEL SELECT MENUS
        // ==========================================
        if (interaction.isChannelSelectMenu()) {
            const settings = await getSettings(interaction.guild.id) || {};
            const selectedId = interaction.values[0];

            if (interaction.customId === 'select_category') {
                if (settings.guild_id) db.run(`UPDATE settings SET category_id=? WHERE guild_id=?`, [selectedId, interaction.guild.id]);
                else db.run(`INSERT INTO settings (guild_id, category_id, log_channel_id, staff_roles, application_rules, application_questions, panel_message, approval_message, denial_message) VALUES (?, ?, '', '', '', '', '', '', '')`, [interaction.guild.id, selectedId]);
                return interaction.reply({ content: `✅ Category set to <#${selectedId}>.`, flags: MessageFlags.Ephemeral });
            }

            if (interaction.customId === 'select_logs') {
                db.run(`UPDATE settings SET log_channel_id=? WHERE guild_id=?`, [selectedId, interaction.guild.id]);
                return interaction.reply({ content: `✅ Logs channel set to <#${selectedId}>.`, flags: MessageFlags.Ephemeral });
            }

            if (interaction.customId === 'edit_select_category') {
                db.run(`UPDATE settings SET category_id=? WHERE guild_id=?`, [selectedId, interaction.guild.id]);
                return interaction.update({ content: `✅ Category updated to <#${selectedId}>.`, components: [] });
            }

            if (interaction.customId === 'edit_select_logs') {
                db.run(`UPDATE settings SET log_channel_id=? WHERE guild_id=?`, [selectedId, interaction.guild.id]);
                return interaction.update({ content: `✅ Logs channel updated to <#${selectedId}>.`, components: [] });
            }
        }

        // ==========================================
        // ROLE SELECT MENUS
        // ==========================================
        if (interaction.isRoleSelectMenu()) {
            const selectedValues = interaction.values;

            if (interaction.customId === 'select_staff_roles') {
                db.run(`UPDATE settings SET staff_roles=? WHERE guild_id=?`, [JSON.stringify(selectedValues), interaction.guild.id]);
                return interaction.reply({ content: '✅ Staff roles updated successfully.', flags: MessageFlags.Ephemeral });
            }

            if (interaction.customId === 'edit_select_roles') {
                db.run(`UPDATE settings SET staff_roles=? WHERE guild_id=?`, [JSON.stringify(selectedValues), interaction.guild.id]);
                return interaction.update({ content: `✅ Staff roles updated to: ${selectedValues.map(id => `<@&${id}>`).join(', ')}`, components: [] });
            }
        }

        // ==========================================
        // MODAL SUBMISSIONS
        // ==========================================
        if (interaction.isModalSubmit()) {
            const settings = await getSettings(interaction.guild.id) || {};

            if (interaction.customId === 'modal_edit_rules') {
                const text = interaction.fields.getTextInputValue('rules_text');
                db.run(`UPDATE settings SET application_rules=? WHERE guild_id=?`, [text, interaction.guild.id]);
                return interaction.reply({ content: '✅ Application rules updated!', flags: MessageFlags.Ephemeral });
            }

            if (interaction.customId === 'modal_edit_questions') {
                const text = interaction.fields.getTextInputValue('questions_text');
                db.run(`UPDATE settings SET application_questions=? WHERE guild_id=?`, [text, interaction.guild.id]);
                return interaction.reply({ content: '✅ Application questions updated!', flags: MessageFlags.Ephemeral });
            }

            if (interaction.customId === 'modal_edit_messages') {
                const approval = interaction.fields.getTextInputValue('approval_text');
                const denial = interaction.fields.getTextInputValue('denial_text');
                db.run(`UPDATE settings SET approval_message=?, denial_message=? WHERE guild_id=?`, [approval, denial, interaction.guild.id]);
                return interaction.reply({ content: '✅ Approval and denial messages updated!', flags: MessageFlags.Ephemeral });
            }

            if (interaction.customId === 'modal_edit_panel') {
                const text = interaction.fields.getTextInputValue('panel_text');
                db.run(`UPDATE settings SET panel_message=? WHERE guild_id=?`, [text, interaction.guild.id]);
                return interaction.reply({ content: '✅ Panel description updated!', flags: MessageFlags.Ephemeral });
            }

            if (interaction.customId.startsWith('deny_')) {
                const applicationId = interaction.customId.split('_')[1];
                const reason = interaction.fields.getTextInputValue('reason');
                const application = await getApplication(applicationId);

                if (!application) {
                    return interaction.reply({ 
                        content: '❌ **Error:** Application data not found in the database. The database may have been reset, or this ticket is old and no longer tracked.', 
                        flags: MessageFlags.Ephemeral 
                    });
                }

                const appNumber = application.guild_app_number || application.id;

                if (application.status === 'APPROVED' || application.status === 'DENIED') return interaction.reply({ content: '❌ This application has already been reviewed.', flags: MessageFlags.Ephemeral });

                const now = Date.now();
                db.run(`UPDATE applications SET status='DENIED', reviewer_id=?, denial_reason=?, reviewed_at=? WHERE id=?`, [interaction.user.id, reason, now, applicationId]);
                await interaction.channel.setName(`🔴-denied-${String(appNumber).padStart(4,'0')}`);
                
                logTranscript(interaction.guild, settings, appNumber, application.user_id, interaction.user.id, 'DENIED', reason);

                const denialEmbed = new EmbedBuilder()
                    .setColor('#ED4245')
                    .setTitle('❌ Application Denied')
                    .setDescription(`<@${application.user_id}>\n\n**Reason:** ${reason}\n\n**Reviewed by:** ${interaction.user}\n\n${settings.denial_message || 'We regret to inform you that your application has been denied.'}\n\n*Please close this ticket using the button below once you have read this.*`);
                
                const closeRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`close_${applicationId}`).setLabel('Close Application').setStyle(ButtonStyle.Danger),
                    new ButtonBuilder().setCustomId(`archive_${applicationId}`).setLabel('Archive').setStyle(ButtonStyle.Secondary)
                );

                await interaction.channel.send({ embeds: [denialEmbed], components: [closeRow] });
                scheduleAutoClose(interaction.channel);

                return interaction.reply({ content: 'Application denied.', flags: MessageFlags.Ephemeral });
            }
        }

        // ==========================================
        // APPLICATION LOGIC (APPLY, APPROVE, ETC.)
        // ==========================================
        if (interaction.isButton() && interaction.customId === 'apply') {
            const settings = await getSettings(interaction.guild.id);
            
            if (!settings || !settings.category_id) return interaction.reply({ content: 'System is currently misconfigured.', flags: MessageFlags.Ephemeral });

            const activeApp = await getActiveApplication(interaction.user.id, interaction.guild.id);
            if (activeApp) return interaction.reply({ content: '❌ You already have an open application in this server. Please wait for it to be reviewed before submitting another.', flags: MessageFlags.Ephemeral });

            db.get(`SELECT MAX(guild_app_number) as max_num FROM applications WHERE guild_id = ?`, [interaction.guild.id], (err, row) => {
                if (err) {
                    console.error("Error getting max_num:", err);
                    return interaction.reply({ content: '❌ Database error while calculating application number.', flags: MessageFlags.Ephemeral }).catch(()=>{});
                }

                const nextNum = (row && row.max_num ? row.max_num : 0) + 1;

                db.run(`INSERT INTO applications (user_id, guild_id, status, guild_app_number) VALUES (?, ?, 'PENDING', ?)`, [interaction.user.id, interaction.guild.id, nextNum], async function (insertErr) {
                    if (insertErr) {
                        console.error("Error inserting application:", insertErr);
                        return interaction.reply({ content: '❌ Database error while creating application. Please contact staff.', flags: MessageFlags.Ephemeral }).catch(()=>{});
                    }

                    const applicationId = this.lastID;
                    
                    try {
                        const userId = interaction.member?.id || interaction.user.id;
                        const everyoneRoleId = interaction.guild?.roles?.everyone?.id || interaction.guild.id; 

                        let channel;
                        try {
                            channel = await interaction.guild.channels.create({
                                name: `🟡-application-${String(nextNum).padStart(4, '0')}`,
                                type: ChannelType.GuildText,
                                parent: settings.category_id,
                                permissionOverwrites: [
                                    { id: everyoneRoleId, deny: [PermissionFlagsBits.ViewChannel] },
                                    { id: userId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
                                    { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels] },
                                    ...JSON.parse(settings.staff_roles || '[]').map(roleId => ({ id: roleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }))
                                ]
                            });
                        } catch (e) {
                            console.error("Failed to create channel:", e);
                            db.run(`DELETE FROM applications WHERE id = ?`, [applicationId]);
                            return interaction.reply({ content: `❌ **Failed to create channel.**\n\n**Diagnosis:** I do not have the necessary permissions to create a ticket channel. Please ensure I have the \`Manage Channels\` permission.\n\n**What to do:** Please go to the main FVRRP server and submit a ticket with this error screenshotted.`, flags: MessageFlags.Ephemeral });
                        }

                        db.run(`UPDATE applications SET channel_id=? WHERE id=?`, [channel.id, applicationId]);

                        const failsafeTimeout = setTimeout(async () => {
                            try {
                                const fetched = await channel.messages.fetch({ limit: 5 });
                                if (fetched.size === 0) {
                                    db.run(`DELETE FROM applications WHERE id = ?`, [applicationId]);
                                    await channel.delete().catch(() => {});
                                    console.log(`Failsafe triggered: Deleted channel ${channel.name} and cleared DB record.`);
                                    if (settings.log_channel_id) {
                                        const logChannel = interaction.guild.channels.cache.get(settings.log_channel_id);
                                        if (logChannel) sendDiagnosticError(logChannel, "The bot failed to send the initial application embed within 10 seconds. The channel has been automatically deleted to prevent ghost tickets. The applicant's DB record was cleared so they can reapply.");
                                    }
                                }
                            } catch (e) {
                                db.run(`DELETE FROM applications WHERE id = ?`, [applicationId]);
                                await channel.delete().catch(() => {});
                            }
                        }, 10000); 

                        const mergedEmbed = new EmbedBuilder()
                            .setColor('#FEE75C')
                            .setTitle('📝 Application Received')
                            .setDescription(`Thank you for applying, <@${interaction.user.id}>.\n\n**📜 Application Rules:**\n${settings.application_rules || 'No rules provided.'}\n\n**Answer the Questions below as best you can:**\n${settings.application_questions || 'No questions provided.'}`)
                            .setTimestamp();

                        const applicantRow = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`close_${applicationId}`).setLabel('Close Application').setStyle(ButtonStyle.Danger));
                        const staffRow = new ActionRowBuilder().addComponents(
                            new ButtonBuilder().setCustomId(`claim_${applicationId}`).setLabel('Claim').setStyle(ButtonStyle.Primary),
                            new ButtonBuilder().setCustomId(`approve_${applicationId}`).setLabel('Approve').setStyle(ButtonStyle.Success),
                            new ButtonBuilder().setCustomId(`deny_${applicationId}`).setLabel('Deny').setStyle(ButtonStyle.Danger)
                        );

                        try {
                            await channel.send({ content: `<@${interaction.user.id}>`, embeds: [mergedEmbed] });
                            await channel.send({ embeds: [new EmbedBuilder().setColor('#2b2d31').setTitle('🛡️ Staff Controls').setDescription('Use the buttons below to manage this application.')], components: [staffRow] });
                            await channel.send({ components: [applicantRow] });
                            clearTimeout(failsafeTimeout);
                            await interaction.reply({ content: `✅ Application created: ${channel}`, flags: MessageFlags.Ephemeral });
                        } catch (e) {
                            console.error("Failed to send messages in new channel:", e);
                            clearTimeout(failsafeTimeout);
                            db.run(`DELETE FROM applications WHERE id = ?`, [applicationId]);
                            await channel.delete().catch(() => {});
                            return interaction.reply({ content: `❌ **Failed to send messages in the ticket.**\n\n**Diagnosis:** I created the channel, but was immediately locked out of it. This usually happens if I lack the \`View Channel\` or \`Send Messages\` permissions, or if the category overrides my permissions.\n\n**What to do:** Please go to the main FVRRP server and submit a ticket with this error screenshotted.`, flags: MessageFlags.Ephemeral });
                        }
                    } catch (outerError) {
                        console.error("Unexpected error in apply logic:", outerError);
                        if (!interaction.replied && !interaction.deferred) {
                            interaction.reply({ content: '❌ An unexpected error occurred while creating the application.', flags: MessageFlags.Ephemeral }).catch(()=>{});
                        }
                    }
                });
            });
            return;
        }

        if (interaction.isButton() && interaction.customId.startsWith('claim_')) {
            const settings = await getSettings(interaction.guild.id);
            const member = interaction.member || await interaction.guild.members.fetch(interaction.user.id);
            if (!isStaff(member, settings)) return interaction.reply({ content: 'Only staff can do that.', flags: MessageFlags.Ephemeral });
            return interaction.reply({ content: `📌 Claimed by ${interaction.user}` });
        }

        if (interaction.isButton() && interaction.customId.startsWith('approve_')) {
            const settings = await getSettings(interaction.guild.id);
            const member = interaction.member || await interaction.guild.members.fetch(interaction.user.id);

            if (!isStaff(member, settings)) return interaction.reply({ content: 'Only staff can do that.', flags: MessageFlags.Ephemeral });

            const applicationId = interaction.customId.split('_')[1];
            const application = await getApplication(applicationId);

            if (!application) {
                return interaction.reply({ 
                    content: '❌ **Error:** Application data not found in the database. The database may have been reset, or this ticket is old and no longer tracked.', 
                    flags: MessageFlags.Ephemeral 
                });
            }

            const appNumber = application.guild_app_number || application.id;

            if (application.status === 'APPROVED' || application.status === 'DENIED') return interaction.reply({ content: '❌ This application has already been reviewed.', flags: MessageFlags.Ephemeral });

            const now = Date.now();
            db.run(`UPDATE applications SET status='APPROVED', reviewer_id=?, reviewed_at=? WHERE id=?`, [interaction.user.id, now, applicationId]);
            await interaction.channel.setName(`🟢-approved-${String(appNumber).padStart(4,'0')}`);
            
            logTranscript(interaction.guild, settings, appNumber, application.user_id, interaction.user.id, 'APPROVED');

            const approvalEmbed = new EmbedBuilder()
                .setColor('#57F287')
                .setTitle('✅ Application Approved')
                .setDescription(`<@${application.user_id}>\n\n**Reviewed by:** ${interaction.user}\n\n${settings.approval_message || 'Congratulations! Your application has been approved.'}\n\n*Please close this ticket using the button below once you have read this.*`);
            
            const closeRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`close_${applicationId}`).setLabel('Close Application').setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId(`archive_${applicationId}`).setLabel('Archive').setStyle(ButtonStyle.Secondary)
            );

            await interaction.channel.send({ embeds: [approvalEmbed], components: [closeRow] });
            scheduleAutoClose(interaction.channel);

            return interaction.reply({ content: '✅ Application approved.', flags: MessageFlags.Ephemeral });
        }

        if (interaction.isButton() && interaction.customId.startsWith('deny_')) {
            const settings = await getSettings(interaction.guild.id);
            const member = interaction.member || await interaction.guild.members.fetch(interaction.user.id);

            if (!isStaff(member, settings)) return interaction.reply({ content: 'Only staff can do that.', flags: MessageFlags.Ephemeral });

            const modal = new ModalBuilder().setCustomId(interaction.customId).setTitle('Deny Application');
            const reason = new TextInputBuilder().setCustomId('reason').setLabel('Reason for Denial').setStyle(TextInputStyle.Paragraph).setRequired(true);
            modal.addComponents(new ActionRowBuilder().addComponents(reason));
            return interaction.showModal(modal);
        }

        if (interaction.isButton() && interaction.customId.startsWith('close_')) {
            const applicationId = interaction.customId.split('_')[1];
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`confirmclose_${applicationId}`).setLabel('Confirm Close').setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId(`cancelclose_${applicationId}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
            );
            return interaction.reply({ content: 'Are you sure you want to close this application?', components: [row], flags: MessageFlags.Ephemeral });
        }

        if (interaction.isButton() && interaction.customId.startsWith('cancelclose_')) {
            return interaction.reply({ content: 'Cancelled.', flags: MessageFlags.Ephemeral });
        }

        if (interaction.isButton() && interaction.customId.startsWith('confirmclose_')) {
            const applicationId = interaction.customId.split('_')[1];
            db.run(`UPDATE applications SET status = 'CLOSED' WHERE id = ? AND status = 'PENDING'`, [applicationId]);
            await interaction.reply({ content: 'Channel will close in 5 seconds.', flags: MessageFlags.Ephemeral });
            setTimeout(async () => { await interaction.channel.delete().catch(() => {}); }, 5000);
            return;
        }

    } catch (error) {
        console.error(error);
        if (interaction.isRepliable()) {
            if (!interaction.replied && !interaction.deferred) {
                interaction.reply({ content: '❌ An error occurred.', flags: MessageFlags.Ephemeral }).catch(() => {});
            } else if (interaction.deferred && !interaction.replied) {
                interaction.editReply({ content: '❌ An unexpected error occurred while executing this action. Please check my permissions and try again.' }).catch(() => {});
            }
        }
    }
});

client.login(process.env.TOKEN);