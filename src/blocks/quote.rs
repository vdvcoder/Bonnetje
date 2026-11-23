//! Citation du jour, tirée d'une liste locale de citations connues : françaises, ou anglaises
//! pour une installation en anglais.

use chrono::{Datelike, NaiveDate};

use crate::doc::{Align, Doc, Style};

#[rustfmt::skip]
const QUOTES: &[(&str, &str)] = &[
    ("Le cœur a ses raisons que la raison ne connaît point.", "Blaise Pascal"),
    ("L'homme n'est qu'un roseau, le plus faible de la nature ; mais c'est un roseau pensant.", "Blaise Pascal"),
    ("Le silence éternel de ces espaces infinis m'effraie.", "Blaise Pascal"),
    ("Je n'ai fait celle-ci plus longue que parce que je n'ai pas eu le loisir de la faire plus courte.", "Blaise Pascal"),
    ("Je pense, donc je suis.", "René Descartes"),
    ("Il faut cultiver notre jardin.", "Voltaire"),
    ("Le doute n'est pas un état bien agréable, mais l'assurance est un état ridicule.", "Voltaire"),
    ("On ne voit bien qu'avec le cœur. L'essentiel est invisible pour les yeux.", "Antoine de Saint-Exupéry"),
    ("Les grandes personnes ne comprennent jamais rien toutes seules.", "Antoine de Saint-Exupéry"),
    ("C'est le temps que tu as perdu pour ta rose qui fait ta rose si importante.", "Antoine de Saint-Exupéry"),
    ("Rien ne sert de courir ; il faut partir à point.", "Jean de La Fontaine"),
    ("On a souvent besoin d'un plus petit que soi.", "Jean de La Fontaine"),
    ("Ce que l'on conçoit bien s'énonce clairement, et les mots pour le dire arrivent aisément.", "Nicolas Boileau"),
    ("Il faut imaginer Sisyphe heureux.", "Albert Camus"),
    ("Au milieu de l'hiver, j'apprenais enfin qu'il y avait en moi un été invincible.", "Albert Camus"),
    ("Mal nommer les choses, c'est ajouter au malheur du monde.", "Albert Camus"),
    ("On ne naît pas femme : on le devient.", "Simone de Beauvoir"),
    ("Un seul être vous manque, et tout est dépeuplé.", "Alphonse de Lamartine"),
    ("Ô temps ! suspends ton vol.", "Alphonse de Lamartine"),
    ("Mon verre n'est pas grand, mais je bois dans mon verre.", "Alfred de Musset"),
    ("Je est un autre.", "Arthur Rimbaud"),
    ("On n'est pas sérieux, quand on a dix-sept ans.", "Arthur Rimbaud"),
    ("Le génie n'est que l'enfance retrouvée à volonté.", "Charles Baudelaire"),
    ("Il faut être toujours ivre. Tout est là.", "Charles Baudelaire"),
    ("La beauté sera convulsive ou ne sera pas.", "André Breton"),
    ("La plus perdue de toutes les journées est celle où l'on n'a pas ri.", "Chamfort"),
    ("Dans les champs de l'observation, le hasard ne favorise que les esprits préparés.", "Louis Pasteur"),
    ("Que sais-je ?", "Michel de Montaigne"),
    ("Parce que c'était lui, parce que c'était moi.", "Michel de Montaigne"),
    ("Chaque homme porte la forme entière de l'humaine condition.", "Michel de Montaigne"),
    ("Tout le monde se plaint de sa mémoire, et personne ne se plaint de son jugement.", "La Rochefoucauld"),
    ("Nous avons tous assez de force pour supporter les maux d'autrui.", "La Rochefoucauld"),
    ("On ne donne rien si libéralement que ses conseils.", "La Rochefoucauld"),
    ("Le pessimisme est d'humeur ; l'optimisme est de volonté.", "Alain"),
    ("Rien n'est plus dangereux qu'une idée, quand on n'a qu'une idée.", "Alain"),
    ("Dis-moi ce que tu manges, je te dirai ce que tu es.", "Jean Anthelme Brillat-Savarin"),
    ("Le style est l'homme même.", "Buffon"),
    ("Vivre sans philosopher, c'est proprement avoir les yeux fermés, sans tâcher jamais de les ouvrir.", "René Descartes"),
];

/// Citations en anglais, d'attribution sûre (un clin d'œil aux bidouilleurs à la fin).
#[rustfmt::skip]
const QUOTES_EN: &[(&str, &str)] = &[
    ("To be, or not to be: that is the question.", "William Shakespeare"),
    ("All the world's a stage, and all the men and women merely players.", "William Shakespeare"),
    ("We are such stuff as dreams are made on, and our little life is rounded with a sleep.", "William Shakespeare"),
    ("The course of true love never did run smooth.", "William Shakespeare"),
    ("Brevity is the soul of wit.", "William Shakespeare"),
    ("There is nothing either good or bad, but thinking makes it so.", "William Shakespeare"),
    ("We know what we are, but know not what we may be.", "William Shakespeare"),
    ("Hope is the thing with feathers that perches in the soul.", "Emily Dickinson"),
    ("Tell all the truth but tell it slant.", "Emily Dickinson"),
    ("I took the one less traveled by, and that has made all the difference.", "Robert Frost"),
    ("The woods are lovely, dark and deep, but I have promises to keep, and miles to go before I sleep.", "Robert Frost"),
    ("The best way out is always through.", "Robert Frost"),
    ("It is a truth universally acknowledged, that a single man in possession of a good fortune, must be in want of a wife.", "Jane Austen"),
    ("There is no charm equal to tenderness of heart.", "Jane Austen"),
    ("It was the best of times, it was the worst of times.", "Charles Dickens"),
    ("I would always rather be happy than dignified.", "Charlotte Brontë"),
    ("A thing of beauty is a joy for ever.", "John Keats"),
    ("Do I contradict myself? Very well then I contradict myself. I am large, I contain multitudes.", "Walt Whitman"),
    ("If you can keep your head when all about you are losing theirs and blaming it on you…", "Rudyard Kipling"),
    ("Hold fast to dreams, for if dreams die, life is a broken-winged bird that cannot fly.", "Langston Hughes"),
    ("Not everything that is faced can be changed, but nothing can be changed until it is faced.", "James Baldwin"),
    ("The unexamined life is not worth living.", "Socrates"),
    ("Well done is better than well said.", "Benjamin Franklin"),
    ("Early to bed and early to rise, makes a man healthy, wealthy, and wise.", "Benjamin Franklin"),
    ("The only thing we have to fear is fear itself.", "Franklin D. Roosevelt"),
    ("Ask not what your country can do for you; ask what you can do for your country.", "John F. Kennedy"),
    ("That's one small step for man, one giant leap for mankind.", "Neil Armstrong"),
    ("Courage is grace under pressure.", "Ernest Hemingway"),
    ("Imagination is more important than knowledge.", "Albert Einstein"),
    ("Life is like riding a bicycle. To keep your balance you must keep moving.", "Albert Einstein"),
    ("Genius is one per cent inspiration, ninety-nine per cent perspiration.", "Thomas Edison"),
    ("Nothing in life is to be feared, it is only to be understood.", "Marie Curie"),
    ("We can only see a short distance ahead, but we can see plenty there that needs to be done.", "Alan Turing"),
    ("Any sufficiently advanced technology is indistinguishable from magic.", "Arthur C. Clarke"),
    ("The best way to predict the future is to invent it.", "Alan Kay"),
    ("It's easier to ask forgiveness than it is to get permission.", "Grace Hopper"),
    ("Simplicity is prerequisite for reliability.", "Edsger W. Dijkstra"),
    ("Premature optimization is the root of all evil.", "Donald Knuth"),
    ("Talk is cheap. Show me the code.", "Linus Torvalds"),
    ("Stay hungry. Stay foolish.", "The Whole Earth Catalog"),
];
#[rustfmt::skip]
const QUOTES_NL: &[(&str, &str)] = &[
    ("Zijn of niet zijn: dat is de vraag.", "William Shakespeare"),
    ("De hele wereld is een toneel, en alle mannen en vrouwen zijn slechts spelers.", "William Shakespeare"),
    ("Wij zijn uit het hout gesneden waar dromen van gemaakt zijn, en ons kleine leven wordt omringd door een slaap.", "William Shakespeare"),
    ("Het pad van ware liefde liep nooit over rozen.", "William Shakespeare"),
    ("Beknoptheid is de ziel van de geest.", "William Shakespeare"),
    ("Niets is goed of slecht, het denken maakt het zo.", "William Shakespeare"),
    ("We weten wat we zijn, maar niet wat we kunnen worden.", "William Shakespeare"),
    ("Hoop is het ding met veren dat in de ziel neerstrijkt.", "Emily Dickinson"),
    ("Vertel de hele waarheid, maar vertel ze schuin.", "Emily Dickinson"),
    ("Ik nam de weg die minder begaan was, en dat maakte al het verschil.", "Robert Frost"),
    ("De bossen zijn mooi, donker en diep, maar ik heb beloften na te komen en mijlen te gaan voor ik slaap.", "Robert Frost"),
    ("De beste uitweg is altijd er dwars doorheen.", "Robert Frost"),
    ("Het is een algemeen erkende waarheid dat een alleenstaande man met een goed fortuin een vrouw nodig heeft.", "Jane Austen"),
    ("Geen charme evenaart een teder hart.", "Jane Austen"),
    ("Het was de beste van alle tijden, het was de slechtste van alle tijden.", "Charles Dickens"),
    ("Ik ben liever gelukkig dan waardig.", "Charlotte Brontë"),
    ("Een mooi ding is een eeuwige vreugde.", "John Keats"),
    ("Spreek ik mezelf tegen? Goed dan, ik spreek mezelf tegen. Ik ben groot, ik bevat massa’s mensen.", "Walt Whitman"),
    ("Als je kalm kunt blijven wanneer iedereen om je heen het hoofd verliest en jou de schuld geeft…", "Rudyard Kipling"),
    ("Houd vast aan dromen, want als dromen sterven, is het leven een vogel met gebroken vleugels die niet kan vliegen.", "Langston Hughes"),
    ("Niet alles wat onder ogen wordt gezien kan veranderen, maar niets kan veranderen zolang het niet onder ogen wordt gezien.", "James Baldwin"),
    ("Een leven zonder zelfonderzoek is het leven niet waard.", "Socrates"),
    ("Goed gedaan is beter dan goed gezegd.", "Benjamin Franklin"),
    ("Vroeg naar bed en vroeg op maakt een man gezond, rijk en wijs.", "Benjamin Franklin"),
    ("Het enige wat we moeten vrezen is de vrees zelf.", "Franklin D. Roosevelt"),
    ("Vraag niet wat je land voor jou kan doen; vraag wat jij voor je land kan doen.", "John F. Kennedy"),
    ("Dat is een kleine stap voor een mens, een gigantische sprong voor de mensheid.", "Neil Armstrong"),
    ("Moed is gratie onder druk.", "Ernest Hemingway"),
    ("Verbeelding is belangrijker dan kennis.", "Albert Einstein"),
    ("Het leven is als fietsen. Om je evenwicht te bewaren moet je in beweging blijven.", "Albert Einstein"),
    ("Genialiteit is één procent inspiratie en negenennegentig procent transpiratie.", "Thomas Edison"),
    ("Niets in het leven is te vrezen, het moet alleen begrepen worden.", "Marie Curie"),
    ("We kunnen maar een korte afstand vooruitzien, maar we zien daar genoeg dat gedaan moet worden.", "Alan Turing"),
    ("Elke voldoende geavanceerde technologie is niet van magie te onderscheiden.", "Arthur C. Clarke"),
    ("De beste manier om de toekomst te voorspellen is haar uit te vinden.", "Alan Kay"),
    ("Het is makkelijker om vergeving te vragen dan om toestemming te krijgen.", "Grace Hopper"),
    ("Eenvoud is een voorwaarde voor betrouwbaarheid.", "Edsger W. Dijkstra"),
    ("Voortijdige optimalisatie is de wortel van alle kwaad.", "Donald Knuth"),
    ("Praten is gratis. Laat me de code zien.", "Linus Torvalds"),
    ("Blijf hongerig. Blijf dwaas.", "The Whole Earth Catalog"),
];

pub fn build(today: NaiveDate) -> Doc {
    let quotes = match crate::i18n::lang() { crate::i18n::Lang::En => QUOTES_EN, crate::i18n::Lang::Nl => QUOTES_NL, crate::i18n::Lang::Fr => QUOTES };
    // Une citation différente chaque jour, la même toute la journée.
    let index = (today.num_days_from_ce() as usize * 7) % quotes.len();
    let (quote, author) = quotes[index];
    let mut doc = Doc::new();
    doc.text(&tr!("« {quote} »", "“{quote}”", "“{quote}”"), Style::default().center());
    doc.text(&format!("- {author}"), Style::default().small().align(Align::Right));
    doc
}
