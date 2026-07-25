-- PostgreSQL only evaluates data-modifying CTEs referenced by the final query.
-- Keep this notes backfill independent so it remains deterministic on every run.

insert into public.android_release_notes (release_id, language_tag, note_text)
select release.id, note.language_tag, note.note_text
from (
    values
        (26::bigint, 'es-ES'::text, E'• Primera versión oficial de Qüata.\n• Red social comunitaria con publicaciones de texto, imagen y vídeo.\n• Chat en tiempo real con notas de voz, adjuntos y notificaciones push.\n• Muro Oficial para cuentas verificadas e instituciones.\n• Traducción integrada, modo sin conexión y sistema SOS inteligente.\n• Mejoras de estabilidad, rendimiento y experiencia de usuario.'::text),
        (26::bigint, 'en-US'::text, E'• First official release of Qüata.\n• Community social network with text, photo and video posts.\n• Real-time chat with voice notes, attachments and push notifications.\n• Official Feed for verified accounts and institutions.\n• Built-in translation, offline support and smart SOS.\n• Stability, performance and user experience improvements.'::text),
        (26::bigint, 'fr-FR'::text, E'• Première version officielle de Qüata.\n• Réseau social communautaire avec publications texte, photo et vidéo.\n• Chat en temps réel avec notes vocales, pièces jointes et notifications push.\n• Fil officiel pour comptes vérifiés et institutions.\n• Traduction intégrée, mode hors ligne et SOS intelligent.\n• Améliorations de stabilité, performances et expérience utilisateur.'::text),
        (27::bigint, 'es-ES'::text, E'• Los chats abiertos se actualizan al volver a la app, mostrando los mensajes recibidos mientras estaba en segundo plano.\n• Ahora puedes responder a un mensaje enviando notas de voz o archivos adjuntos.\n• El bloqueo por proximidad espera unos segundos antes de apagar la pantalla, evitando activaciones accidentales.'::text),
        (27::bigint, 'en-US'::text, E'• Open chats now refresh when you return to the app, showing messages received in the background.\n• You can now reply to a message with voice notes or attachments.\n• Proximity screen lock now waits a few seconds before turning the screen off, preventing accidental activation.'::text),
        (27::bigint, 'fr-FR'::text, E'• Les conversations ouvertes se mettent à jour au retour dans l’application, avec les messages reçus en arrière-plan.\n• Vous pouvez maintenant répondre à un message avec une note vocale ou une pièce jointe.\n• Le verrouillage par proximité attend quelques secondes avant d’éteindre l’écran, pour éviter les activations accidentelles.'::text),
        (28::bigint, 'es-ES'::text, E'• Chats más fiables, con respuestas, adjuntos y estados consistentes incluso sin conexión.\n• Las conversaciones se abren en el último mensaje y se actualizan con mayor fluidez.\n• Mejor gestión del teclado, la conectividad y las conversaciones individuales y grupales.\n• Mejoras generales de rendimiento, estabilidad y edición de imágenes.'::text),
        (28::bigint, 'en-US'::text, E'• More reliable chats, with consistent replies, attachments, and message states even offline.\n• Conversations now open at the latest message and update more smoothly.\n• Improved keyboard, connectivity, and individual and group conversation handling.\n• General performance, stability, and image editing improvements.'::text),
        (28::bigint, 'fr-FR'::text, E'• Chats plus fiables, avec des réponses, pièces jointes et états cohérents même hors connexion.\n• Les conversations s’ouvrent sur le dernier message et se mettent à jour plus facilement.\n• Meilleure gestion du clavier, de la connectivité et des conversations individuelles ou de groupe.\n• Améliorations générales des performances, de la stabilité et de l’édition d’images.'::text)
) as note(version_code, language_tag, note_text)
join public.android_releases release
  on release.package_name = 'com.quata'
 and release.track = 'production'
 and release.version_code = note.version_code
on conflict (release_id, language_tag) do update
set note_text = excluded.note_text,
    updated_at = now();
